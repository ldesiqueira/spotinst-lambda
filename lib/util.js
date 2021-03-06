var _           = require('lodash');
var util        = require('lambda-formation').util;
var request     = require('request');
var diff        = require('deep-diff');
var packageJson = require('../package');

const RESOURCES = ['group', 'subscription', 'healthCheck', 'beanstalkElastigroup', 'mrScaler'];

const SPOTINST_CF_USER_AGENT = 'spotinst-cloud-formation' + '/' + packageJson.version;

function getToken(event, cb) {
  var config = event.ResourceProperties || event;
  
  if(config.username && config.password && config.clientId && config.clientSecret) {
    var request      = require('request');
    var tokenOptions = {
      method:  'POST',
      url:     'https://oauth.spotinst.io/token',
      headers: {'content-type': 'application/x-www-form-urlencoded'},
      body:    'username=' + config.username + '&password=' + config.password + '&grant_type=password&client_id=' + config.clientId + '&client_secret=' + config.clientSecret
    };
    request(tokenOptions, function(err, response, body) {
      if(err) return cb("Token creation failed: " + err);
      if(response.statusCode > 201) return cb("Token creation failed: " + response.statusMessage);
      
      var accessToken = JSON.parse(body)['response']['items'][0]['accessToken'];
      cb(null, accessToken);
    });
  }
  else if(config.accessToken) {
    cb(null, config.accessToken);
  }
  else {
    cb("No valid long or short term credentials provided");
  }
}

function addNulls(oldConfig, newConfig) {
  var patchConfig = _.cloneDeep(newConfig);
  
  diff.observableDiff(oldConfig, patchConfig, function(d) {
    if(d.kind === "D") {
      var patch = new Object();
      Object.defineProperty(patch, "kind", {
        value:      "N",
        enumerable: true
      });
      Object.defineProperty(patch, "path", {
        value:      d.path,
        enumerable: true
      });
      Object.defineProperty(patch, "rhs", {
        value:      null,
        enumerable: true
      });
      
      diff.applyChange(patchConfig, oldConfig, patch);
    }
  });
  
  return patchConfig;
}

function getConfig(event, cb) {
  var config;
  
  if(event.ResourceProperties) {
    var matchResourceConfig = _.intersection(_.keys(event.ResourceProperties), RESOURCES);
    if(matchResourceConfig.length === 1) {
      if(event.OldResourceProperties) {
        config = addNulls(
          event.OldResourceProperties[matchResourceConfig[0]],
          event.ResourceProperties[matchResourceConfig[0]]
        );
      }
      else {
        config = event.ResourceProperties[matchResourceConfig[0]];
      }
    }
  }
  if(!config) {
    var matchResourceConfig = _.intersection(_.keys(event), RESOURCES);
    config                  = event[matchResourceConfig[0]];
  }
  
  if(config) {
    cb(null, config);
  }
  /* TODO
   *else if (config.configUrl) {
   *  var tokenOptions = {
   *    method: 'GET',
   *    url: config.configUrl
   *  };
   *  request(requestOptions, function (err, response, body) {
   *    if (err) return cb(err);
   *    if (response.statusCode != 200) return cb(response.statusMessage);
   *    var jsonConfig = JSON.parse(body);
   *    cb(null,jsonConfig);
   *  });
   *}
   */
  else {
    cb("Must define groupConfig");
  }
  
}

function getUserAgent() {
  return SPOTINST_CF_USER_AGENT;
}

module.exports.getUserAgent = getUserAgent;

module.exports.getToken = getToken;

module.exports.getConfig = getConfig;

module.exports.addNulls = addNulls;

module.exports.getTokenAndConfig = function(event, cb) {
  var count    = 0;
  var response = {};
  
  var done = function(err, name, obj) {
    if(err) return cb(err);
    count          = count + 1;
    response[name] = obj;
    if(count == 2) {
      return cb(null, response);
    }
  };
  
  getConfig(event, function(err, cfg) {
    done(err, 'config', cfg);
  });
  
  getToken(event, function(err, t) {
    done(err, 'token', t);
  });
};

module.exports.validateResponse = function(spotResponse) {
  var res     = spotResponse.res;
  var body    = spotResponse.body;
  var event   = spotResponse.event;
  var context = spotResponse.context;
  
  console.log('Spotinst response: ' + JSON.stringify(body, null, 2));
  
  if(res.statusCode > 201) {
    var errMsg = '';
    try {
      var errors = body.response.errors;
      errors.forEach(function(error) {
        errMsg = errMsg + error.code + ": " + error.message + "\n";
      });
    }
    catch(e) {
      errMsg = res.statusCode;
    }
    
    if(spotResponse.failureCb != null) {
      spotResponse.failureCb(spotResponse);
    }
    else {
      return util.done(spotResponse.resource + " " + spotResponse.action + " failed: " + errMsg, event, context);
    }
  }
  else {
    spotResponse.successCb(spotResponse);
  }
};

module.exports.parseBoolean = function(str) {
  let retVal;
  
  if(str != null) {
    if(_.isString(str)) {
      if(str === 'true') {
        retVal = true;
      }
      else if(str === 'false') {
        retVal = false;
      }
    }
    else if(_.isBoolean(str)) {
      retVal = str;
    }
  }
  
  return retVal;
};

module.exports.parseBoolean = function(str) {
  let retVal;
  
  if(str != null) {
    if(_.isString(str)) {
      if(str === 'true') {
        retVal = true;
      }
      else if(str === 'false') {
        retVal = false;
      }
    }
    else if(_.isBoolean(str)) {
      retVal = str;
    }
  }
  
  return retVal;
};

module.exports.getSpotinstAccountId = function(event) {
  var accountId = _.get(event, 'ResourceProperties.accountId') || _.get(event, 'accountId');
  console.log('spotinst account id is: ', accountId);
  return accountId;
};

module.exports.parseGroupConfig = function(config) {
  let retVal          = _.cloneDeep(config);
  let targetGroupARNs = _.get(config, 'compute.launchSpecification.loadBalancersConfig.targetGroupARNs');
  
  if(targetGroupARNs != null) {
    let loadBalancers = _.get(config, 'compute.launchSpecification.loadBalancersConfig.loadBalancers') || [];
    
    _.forEach(targetGroupARNs, tgARN => {
      let isTGExists = _.find(loadBalancers, {arn: tgARN}) != null;
      
      if(isTGExists === false) {
        loadBalancers.push({
          name: tgARN.split('/')[1],
          arn:  tgARN,
          type: 'TARGET_GROUP'
        });
      }
    });
    
    if(_.isEmpty(loadBalancers) === false) {
      _.set(retVal, 'compute.launchSpecification.loadBalancersConfig.loadBalancers', loadBalancers);
    }
    
    _.set(retVal, 'compute.launchSpecification.loadBalancersConfig.targetGroupARNs', undefined);
  }
  
  return retVal;
};