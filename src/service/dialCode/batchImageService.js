var _ = require('lodash')
var ColorUtil = require('./../../utils/colorUtil')
var colorConvert = new ColorUtil()
var dbModel = require('./../../utils/cassandraUtil').getConnections('dialcodes')
var messageUtils = require('./../messageUtil')
var respUtil = require('response_util')
var LOG = require('sb_logger_util')
var path = require('path')
var filename = path.basename(__filename)
var dialCodeMessage = messageUtils.DIALCODE
var responseCode = messageUtils.RESPONSE_CODE
var errorCorrectionLevels = ['L', 'M', 'Q', 'H']
var Telemetry = require('sb_telemetry_util')
var telemetry = new Telemetry()
var batchModelProperties = ['processid', 'dialcodes', 'config', 'status', 'channel', 'publisher']
var KafkaService = require('./../../helpers/qrCodeKafkaProducer.js') 
var utilsService = require('../utilsService')

const defaultConfig = {
  "errorCorrectionLevel": "H",
  "pixelsPerBlock": 2,
  "qrCodeMargin": 3,
  "textFontName": "Verdana",
  "textFontSize": 11,
  "textCharacterSpacing": 0.1,
  "imageFormat": "png",
  "colourModel": "Grayscale",
  "imageBorderSize": 1
}

function BatchImageService(config) {
  this.config = _.merge(defaultConfig, config);
}

BatchImageService.prototype.createRequest = function (data, channel, publisher, rspObj, callback) {
  var processId = dbModel.uuid()
  var dialcodes = _.map(data.dialcodes, 'text');
  // Below line added for ignore eslint camel case issue.
  /* eslint new-cap: ["error", { "newIsCap": false }] */
  var batch = new dbModel.instance.dialcode_batch({
    processid: processId,
    dialcodes: dialcodes,
    config: this.configToString(),
    status: 0,
    channel: channel,
    publisher: publisher
  })

  // Generate audit event
  var telemetryData = Object.assign({}, rspObj.telemetryData)
  const auditEventData = telemetry.auditEventData(batchModelProperties, 'Create', 'NA')
  const cdata = [{ id: dialcodes.toString(), type: 'dialCode' }, { id: publisher, type: 'publisher' }]
  if (telemetryData.context) {
    telemetryData.context.cdata = cdata
  }
  telemetryData.edata = auditEventData
  telemetry.audit(telemetryData)

  batch.save(function (error) {
    if (error) {
      LOG.error({ filename, 'error while inserting record :': error })
      callback(error, null)
    } else {
      data.processId = processId;
      KafkaService.sendRecord(data, function(err, res){
        if(err){
          callback(err, null)
        } else {
          callback(null, processId)
        }
      })
      //TODO: Send to Kafka
     
    }
  })
}

BatchImageService.prototype.getStatus = function (rspObj, processId) {
  return new Promise(function (resolve, reject) {
    try {
      var processUUId = dbModel.uuidFromString(processId)
    } catch (e) {
      console.log('err', e)
      rspObj.errCode = dialCodeMessage.PROCESS.NOT_FOUND_CODE
      rspObj.errMsg = dialCodeMessage.PROCESS.NOT_FOUND_MESSAGE
      rspObj.responseCode = responseCode.RESOURCE_NOT_FOUND
      reject(new Error(JSON.stringify({ code: 404, data: respUtil.errorResponse(rspObj) })))
    }
    dbModel.instance.dialcode_batch.findOne({ processid: processUUId }, function (err, batch) {
      if (err) {
        rspObj.errCode = dialCodeMessage.PROCESS.FAILED_CODE
        rspObj.errMsg = dialCodeMessage.PROCESS.FAILED_MESSAGE
        rspObj.responseCode = responseCode.SERVER_ERROR
        reject(new Error(JSON.stringify({ code: 500, data: respUtil.errorResponse(rspObj) })))
      } else if (!batch) {
        rspObj.errCode = dialCodeMessage.PROCESS.NOT_FOUND_CODE
        rspObj.errMsg = dialCodeMessage.PROCESS.NOT_FOUND_MESSAGE
        rspObj.responseCode = responseCode.RESOURCE_NOT_FOUND
        reject(new Error(JSON.stringify({ code: 404, data: respUtil.errorResponse(rspObj) })))
      } else {
        if (batch.status !== 2) {
          rspObj.result.status = dialCodeMessage.PROCESS.INPROGRESS_MESSAGE
          resolve({ code: 200, data: respUtil.successResponse(rspObj) })
        } else {
          rspObj.result.status = dialCodeMessage.PROCESS.COMPLETED
          rspObj.result.url = batch.url
          resolve({ code: 200, data: respUtil.successResponse(rspObj) })
        }
      }
    })
  })
}

BatchImageService.prototype.restartProcess = function (rspObj, processId, force) {
  return new Promise(function (resolve, reject) {
    try {
      var processUUId = dbModel.uuidFromString(processId)
    } catch (e) {
      console.log('err', e)
      LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename, 'restartProcess',
        'Process id not found', e))
      rspObj.errCode = dialCodeMessage.PROCESS.NOT_FOUND_CODE
      rspObj.errMsg = dialCodeMessage.PROCESS.NOT_FOUND_MESSAGE
      rspObj.responseCode = responseCode.RESOURCE_NOT_FOUND
      reject(new Error(JSON.stringify({ code: 404, data: respUtil.errorResponse(rspObj) })))
    }
    // Finding process details from DB
    dbModel.instance.dialcode_batch.findOne({ processid: processUUId }, function (err, batch) {
      if (err) {
        LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename,
          'restartProcess', 'DB error while fetching process details', err))
        rspObj.errCode = dialCodeMessage.PROCESS.FAILED_CODE
        rspObj.errMsg = dialCodeMessage.PROCESS.FAILED_MESSAGE
        rspObj.responseCode = responseCode.SERVER_ERROR
        reject(new Error(JSON.stringify({ code: 500, data: respUtil.errorResponse(rspObj) })))
      } else if (!batch) {
        LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename,
          'restartProcess', 'Process details not found in DB', err))
        rspObj.errCode = dialCodeMessage.PROCESS.NOT_FOUND_CODE
        rspObj.errMsg = dialCodeMessage.PROCESS.NOT_FOUND_MESSAGE
        rspObj.responseCode = responseCode.RESOURCE_NOT_FOUND
        reject(new Error(JSON.stringify({ code: 404, data: respUtil.errorResponse(rspObj) })))
      } else {
        // If force is sent true in query param or batch status is 2 or 3
        if (force === 'true' || batch.status === 2 || batch.status === 3) {
          LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename,
            'restartProcess', 'Process updation initiated', batch))
          batch.status = 0
          // Updating process status to 0
          dbModel.instance.dialcode_batch.update(
            { processid: processUUId },
            { status: batch.status }, function (err) {
              if (err) {
                LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename,
                  'restartProcess', 'Updating process details failed in DB', err))
                rspObj.errCode = dialCodeMessage.PROCESS.FAILED_CODE
                rspObj.errMsg = dialCodeMessage.PROCESS.FAILED_UPDATE_MESSAGE
                rspObj.responseCode = responseCode.SERVER_ERROR
                reject(new Error(JSON.stringify({ code: 500, data: respUtil.errorResponse(rspObj) })))
              } else {
                // Sending record to kafka
                KafkaService.sendRecord(batch, function (err, res) {
                  if (err) {
                    LOG.error(utilsService.getLoggerData(rspObj, 'ERROR', filename,
                      'restartProcess', 'Kafka send record failed', err))
                    rspObj.errCode = dialCodeMessage.PROCESS.FAILED_CODE
                    rspObj.errMsg = dialCodeMessage.PROCESS.FAILED_KAFKA_MESSAGE
                    rspObj.responseCode = responseCode.SERVER_ERROR
                    reject(new Error(JSON.stringify({ code: 500, data: respUtil.errorResponse(rspObj) })))
                  } else {
                    LOG.info(utilsService.getLoggerData(rspObj, 'INFO', filename,
                      'restartProcess', 'Kafka send record successful', batch))
                    rspObj.result.status = dialCodeMessage.PROCESS.INPROGRESS_MESSAGE
                    resolve({ code: 200, data: respUtil.successResponse(rspObj) })
                  }
                })
              }
            })
        } else {
          rspObj.result.status = dialCodeMessage.PROCESS.INPROGRESS_MESSAGE
          resolve({ code: 500, data: respUtil.errorResponse(rspObj) })
        }
      }
    })
  })
}

BatchImageService.prototype.configToString = function () {
  return _.mapValues(this.config, _.method('toString'))
}


module.exports = BatchImageService
