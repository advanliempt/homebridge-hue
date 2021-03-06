// homebridge-hue/lib/HueSensor.js
// Copyright © 2016-2019 Erik Baauw. All rights reserved.
//
// Homebridge plugin for Philips Hue and/or deCONZ.
//
// HueSensor provides support for Philips Hue sensors.

'use strict'

const moment = require('moment')

// Link this module to HuePlatform.
module.exports = {
  setHomebridge: setHomebridge,
  HueSensor: HueSensor
}

function toInt (value, minValue, maxValue) {
  const n = parseInt(value)
  if (isNaN(n) || n < minValue) {
    return minValue
  }
  if (n > maxValue) {
    return maxValue
  }
  return n
}

const daylightEvents = {
  '100': { name: 'Solar Midnight', period: 'Night' },
  '110': { name: 'Astronomical Dawn', period: 'Astronomical Twilight' },
  '120': { name: 'Nautical Dawn', period: 'Nautical Twilight' },
  '130': { name: 'Dawn', period: 'Twilight' },
  '140': { name: 'Sunrise', period: 'Sunrise' },
  '150': { name: 'End Sunrise', period: 'Golden Hour' },
  '160': { name: 'End Golden Hour', period: 'Day' },
  '170': { name: 'Solar Noon', period: 'Day' },
  '180': { name: 'Start Golden Hour', period: 'Golden Hour' },
  '190': { name: 'Start Sunset', period: 'Sunset' },
  '200': { name: 'Sunset', period: 'Twilight' },
  '210': { name: 'Dusk', period: 'Nautical Twilight' },
  '220': { name: 'Nautical Dusk', period: 'Astronomical Twilight' },
  '230': { name: 'Astronomical Dusk', period: 'Night' }
}

const daylightPeriods = {
  'Night': { lightlevel: 0, daylight: false, dark: true },
  'Astronomical Twilight': { lightlevel: 100, daylight: false, dark: true },
  'Nautical Twilight': { lightlevel: 1000, daylight: false, dark: true },
  'Twilight': { lightlevel: 10000, daylight: false, dark: false },
  'Sunrise': { lightlevel: 15000, daylight: true, dark: false },
  'Sunset': { lightlevel: 20000, daylight: true, dark: false },
  'Golden Hour': { lightlevel: 40000, daylight: true, dark: false },
  'Day': { lightlevel: 65535, daylight: true, dark: false }
}

// ===== Homebridge ============================================================

// Link this module to homebridge.
let Service
let Characteristic
let my
let eve
// let HistoryService

let SINGLE
let SINGLE_DOUBLE
let SINGLE_LONG
let SINGLE_DOUBLE_LONG
// let DOUBLE
let DOUBLE_LONG
// let LONG

function setHomebridge (homebridge, _my, _eve) {
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic
  my = _my
  eve = _eve
  SINGLE = {
    minValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    maxValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
  }
  SINGLE_DOUBLE = {
    minValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    maxValue: Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS
  }
  SINGLE_LONG = {
    minValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    maxValue: Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
    validValues: [
      Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      Characteristic.ProgrammableSwitchEvent.LONG_PRESS
    ]
  }
  SINGLE_DOUBLE_LONG = {
    minValue: Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
    maxValue: Characteristic.ProgrammableSwitchEvent.LONG_PRESS
  }
  // DOUBLE = {
  //   minValue: Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
  //   maxValue: Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS
  // }
  DOUBLE_LONG = {
    minValue: Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
    maxValue: Characteristic.ProgrammableSwitchEvent.LONG_PRESS
  }
  // LONG = {
  //   minValue: Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
  //   maxValue: Characteristic.ProgrammableSwitchEvent.LONG_PRESS
  // }
}

function hkLightLevel (v) {
  let l = v ? Math.pow(10, (v - 1) / 10000) : 0.0001
  l = Math.round(l * 10000) / 10000
  return l > 100000 ? 100000 : l < 0.0001 ? 0.0001 : l
}

const PRESS = 0
const HOLD = 1
const SHORT_RELEASE = 2
const LONG_RELEASE = 3
const DOUBLE_PRESS = 4
const TRIPLE_PRESS = 5
const QUADRUPLE_PRESS = 6
const SHAKE = 7
const DROP = 8
const TILT = 9

// As homebridge-hue polls the Hue bridge, not all dimmer switch buttonevents
// are received reliably.  Consequently, we only issue one HomeKit change per
// Press/Hold/Release event series.
function hkZLLSwitchAction (value, oldValue, repeat = false) {
  const button = Math.floor(value / 1000)
  const oldButton = Math.floor(oldValue / 1000)
  const event = value % 1000
  const oldEvent = oldValue % 1000
  switch (event) {
    case PRESS:
      // Wait for Hold or Release after press.
      return null
    case SHORT_RELEASE:
      return Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
    case HOLD:
    case LONG_RELEASE:
      if (repeat && (button === 2 || button === 3)) {
        return Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
      }
      if (button === oldButton && oldEvent === HOLD) {
        // Already issued action on previous Hold.
        return null
      }
      // falls through
    case TRIPLE_PRESS:
    case QUADRUPLE_PRESS:
      return Characteristic.ProgrammableSwitchEvent.LONG_PRESS
    case DOUBLE_PRESS:
    case SHAKE:
    case DROP:
      return Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS
    default:
      return null
  }
}

// ===== HueSensor =============================================================

function HueSensor (accessory, id, obj) {
  this.accessory = accessory
  this.id = id
  this.obj = obj
  this.bridge = this.accessory.bridge
  this.log = this.accessory.log
  this.serialNumber = this.accessory.serialNumber
  this.name = this.obj.name
  this.hk = {}
  this.resource = '/sensors/' + id
  this.serviceList = []

  if (this.obj.type[0] === 'Z') {
    // Zigbee sensor.
    this.manufacturer = this.obj.manufacturername
    this.model = this.obj.modelid
    this.endpoint = this.obj.uniqueid.split('-')[1]
    this.cluster = this.obj.uniqueid.split('-')[2]
    this.subtype = this.endpoint + '-' + this.cluster
    this.version = this.obj.swversion
  } else {
    // Hue bridge internal sensor.
    this.manufacturer = this.bridge.manufacturername
    if (this.accessory.isMulti) {
      this.model = 'MultiCLIP'
      this.subtype = this.id
    } else if (
      this.obj.manufacturername === 'homebridge-hue' &&
      this.obj.modelid === this.obj.type &&
      this.obj.uniqueid.split('-')[1] === this.id
    ) {
      // Combine multiple CLIP sensors into one accessory.
      this.model = 'MultiCLIP'
      this.subtype = this.id
    } else {
      this.model = this.obj.type
    }
    this.version = this.bridge.version
  }
  this.infoService = this.accessory.getInfoService(this)

  // See: http://www.developers.meethue.com/documentation/supported-sensors
  let durationKey = 'duration'
  let readonlySensitivity = true
  switch (this.obj.type) {
    case 'ZGPSwitch':
      if (
        this.obj.manufacturername === 'Philips' &&
        this.obj.modelid === 'ZGPSWITCH'
      ) {
        // 1.1 - Hue tap
        this.createLabel(Characteristic.ServiceLabelNamespace.DOTS)
        this.createButton(1, '1', SINGLE)
        this.createButton(2, '2', SINGLE)
        this.createButton(3, '3', SINGLE)
        this.createButton(4, '4', SINGLE)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return { 34: 1, 16: 2, 17: 3, 18: 4 }[v] },
          homekitAction: function () { return 0 }
        }
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      break
    case 'ZLLSwitch':
    case 'ZHASwitch':
      if (
        this.obj.manufacturername === 'Philips' &&
        (this.obj.modelid === 'RWL021' || this.obj.modelid === 'RWL020')
      ) {
        // 1.2 - Hue wireless dimmer switch
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'On', SINGLE_LONG)
        if (this.bridge.platform.config.hueDimmerRepeat) {
          this.repeat = true
          this.createButton(2, 'Dim Up', SINGLE)
          this.createButton(3, 'Dim Down', SINGLE)
        } else {
          this.createButton(2, 'Dim Up', SINGLE_LONG)
          this.createButton(3, 'Dim Down', SINGLE_LONG)
        }
        this.createButton(4, 'Off', SINGLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'IKEA of Sweden' &&
        this.obj.modelid === 'TRADFRI remote control'
      ) {
        // Ikea Trådfri remote
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'On/Off', SINGLE)
        this.createButton(2, 'Dim Up', SINGLE_LONG)
        this.createButton(3, 'Dim Down', SINGLE_LONG)
        this.createButton(4, 'Previous', SINGLE_LONG)
        this.createButton(5, 'Next', SINGLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'IKEA of Sweden' &&
        this.obj.modelid === 'TRADFRI wireless dimmer'
      ) {
        // Ikea Trådfri dimmer
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'On', SINGLE)
        this.createButton(2, 'Dim Up', SINGLE)
        this.createButton(3, 'Dim Down', SINGLE)
        this.createButton(4, 'Off', SINGLE)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'innr' &&
        this.obj.modelid === 'RC 110'
      ) {
        // innr RC 110 remote, exposed as multiple ZHASwitch resources
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        if (this.endpoint === '01') {
          this.createButton(1, 'On/Off', SINGLE)
          this.createButton(2, 'Dim Up', SINGLE_LONG)
          this.createButton(3, 'Dim Down', SINGLE_LONG)
          this.createButton(4, '1', SINGLE)
          this.createButton(5, '2', SINGLE)
          this.createButton(6, '3', SINGLE)
          this.createButton(7, '4', SINGLE)
          this.createButton(8, '5', SINGLE)
          this.createButton(9, '6', SINGLE)
        } else {
          const light = parseInt(this.endpoint) - 2
          const button = 7 + light * 3
          this.createButton(button, `On/Off ${light}`, SINGLE)
          this.createButton(button + 1, `Dim Up ${light}`, SINGLE_LONG)
          this.createButton(button + 2, `Dim Down ${light}`, SINGLE_LONG)
        }
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'ubisys' &&
        this.obj.modelid === 'S1 (5501)'
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, '1', SINGLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'ubisys' && (
          this.obj.modelid === 'S1-R (5601)' ||
          this.obj.modelid === 'S2 (5502)' ||
          this.obj.modelid === 'S2-R (5602)' ||
          this.obj.modelid === 'D1 (5503)' ||
          this.obj.modelid === 'D1-R (5603)'
        )
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, '1', SINGLE_LONG)
        this.createButton(2, '2', SINGLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'ubisys' && (
          this.obj.modelid === 'C4 (5504)' ||
          this.obj.modelid === 'C4-R (5604)'
        )
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, '1', SINGLE_LONG)
        this.createButton(2, '2', SINGLE_LONG)
        this.createButton(3, '3', SINGLE_LONG)
        this.createButton(4, '4', SINGLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'dresden elektronik' &&
        this.obj.modelid === 'Scene Switch'
      ) {
        // dresden elektronik scene switch
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'On', SINGLE_LONG)
        this.createButton(2, 'Off', SINGLE_LONG)
        this.createButton(3, 'Scene 1', SINGLE)
        this.createButton(4, 'Scene 2', SINGLE)
        this.createButton(5, 'Scene 3', SINGLE)
        this.createButton(6, 'Scene 4', SINGLE)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.sensor_switch' ||
          this.obj.modelid === 'lumi.sensor_86sw1'
        )
      ) {
        // Xiaomi Aqara smart wireless switch
        // Xiaomi Mi wireless switch
        // Xiaomi wall switch (single button)
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Button', SINGLE_DOUBLE)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.sensor_switch.aq2' ||
          this.obj.modelid === 'lumi.sensor_switch.aq3'
        )
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Button', SINGLE_DOUBLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.sensor_86sw2' ||
          this.obj.modelid === 'lumi.ctrl_ln2.aq1'
        )
      ) {
        // Xiaomi wall switch (two buttons)
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Left', SINGLE_DOUBLE)
        this.createButton(2, 'Right', SINGLE_DOUBLE)
        this.createButton(3, 'Both', SINGLE_DOUBLE)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.remote.b1acn01' ||
          this.obj.modelid === 'lumi.remote.b186acn01'
        )
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Left', SINGLE_DOUBLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'LUMI' &&
        this.obj.modelid === 'lumi.remote.b286acn01'
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Left', SINGLE_DOUBLE_LONG)
        this.createButton(2, 'Right', SINGLE_DOUBLE_LONG)
        this.createButton(3, 'Both', SINGLE_DOUBLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'LUMI' &&
        this.obj.modelid === 'lumi.vibration.aq1'
      ) {
        // Xiaomi Aqara vibration sensor
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Button', SINGLE_DOUBLE_LONG)
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: function (v) {
            const event = v % 1000
            switch (event) {
              case SHAKE:
                return Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
              case DROP:
                return Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS
              case TILT:
                return Characteristic.ProgrammableSwitchEvent.LONG_PRESS
              default:
                return null
            }
          }
        }
      } else if (
        this.obj.manufacturername === 'LUMI' &&
        this.obj.modelid.startsWith('lumi.sensor_cube')
      ) {
        // Xiaomi Mi smart cube
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        if (this.endpoint === '02') {
          this.createButton(1, 'Side 1', SINGLE_DOUBLE_LONG)
          this.createButton(2, 'Side 2', SINGLE_DOUBLE_LONG)
          this.createButton(3, 'Side 3', SINGLE_DOUBLE_LONG)
          this.createButton(4, 'Side 4', SINGLE_DOUBLE_LONG)
          this.createButton(5, 'Side 5', SINGLE_DOUBLE_LONG)
          this.createButton(6, 'Side 6', SINGLE_DOUBLE_LONG)
          this.createButton(7, 'Cube', DOUBLE_LONG)
          this.type = {
            key: 'buttonevent',
            homekitValue: function (v) { return Math.floor(v / 1000) },
            homekitAction: function (v) {
              if (v % 1000 === 0) {
                return Characteristic.ProgrammableSwitchEvent.LONG_PRESS
              } else if (v % 1000 === Math.floor(v / 1000) || v % 1000 === 8) {
                return Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS
              } else {
                return Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
              }
            }
          }
        } else if (this.endpoint === '03') {
          this.createButton(8, 'Right', SINGLE_DOUBLE_LONG)
          this.createButton(9, 'Left', SINGLE_DOUBLE_LONG)
          this.type = {
            key: 'buttonevent',
            homekitValue: function (v) { return v > 0 ? 8 : 9 },
            homekitAction: function (v) {
              return Math.abs(v) < 4500
                ? Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
                : Math.abs(v) < 9000
                  ? Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS
                  : Characteristic.ProgrammableSwitchEvent.LONG_PRESS
            }
          }
        }
      } else if (
        this.obj.manufacturername === 'Insta' && (
          this.obj.modelid === 'WS_3f_G_1' ||
          this.obj.modelid === 'HS_4f_GJ_1' ||
          this.obj.modelid === 'WS_4f_J_1'
        )
      ) {
        // Gira Light Link wall transmitter
        // Gira/Jung Light Link hand transmitter
        // Jung Light Link wall transmitter
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Off', SINGLE_DOUBLE_LONG)
        this.createButton(2, 'On', SINGLE_DOUBLE_LONG)
        this.createButton(3, 'Scene 1', SINGLE)
        this.createButton(4, 'Scene 2', SINGLE)
        this.createButton(5, 'Scene 3', SINGLE)
        this.createButton(6, 'Scene 4', SINGLE)
        if (this.obj.modelid !== 'WS_3f_G_1') {
          this.createButton(7, 'Scene 5', SINGLE)
          this.createButton(8, 'Scene 6', SINGLE)
        }
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'Busch-Jaeger' && (
          this.obj.modelid === 'RM01' ||
          this.obj.modelid === 'RB01'
        )
      ) {
        // Busch-Jaeger Light Link control element (mains-powered)
        // Busch-Jaeger Light Link wall-mounted transmitter
        // Exposed as multiple ZHASwitch resources?
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        if (this.endpoint === '0a') {
          this.createButton(1, 'Button 1', SINGLE_LONG)
          this.createButton(2, 'Button 2', SINGLE_LONG)
        } else if (this.endpoint === '0b') {
          this.createButton(3, 'Button 3', SINGLE_LONG)
          this.createButton(4, 'Button 4', SINGLE_LONG)
        } else if (this.endpoint === '0c') {
          this.createButton(5, 'Button 5', SINGLE_LONG)
          this.createButton(6, 'Button 6', SINGLE_LONG)
        } else if (this.endpoint === '0d') {
          this.createButton(7, 'Button 7', SINGLE_LONG)
          this.createButton(8, 'Button 8', SINGLE_LONG)
        }
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else if (
        this.obj.manufacturername === 'icasa' && (
          this.obj.modelid === 'ICZB-KPD12' ||
          this.obj.modelid === 'ICZB-KPD14S' ||
          this.obj.modelid === 'ICZB-KPD18S'
        )
      ) {
        this.createLabel(Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS)
        this.createButton(1, 'Off', SINGLE_LONG)
        this.createButton(2, 'On', SINGLE_LONG)
        if (this.obj.modelid !== 'ICZB-KPD12') {
          this.createButton(3, 'S1', SINGLE)
          this.createButton(4, 'S2', SINGLE)
          if (this.obj.modelid === 'ICZB-KPD18S') {
            this.createButton(5, 'S3', SINGLE)
            this.createButton(6, 'S4', SINGLE)
            this.createButton(7, 'S5', SINGLE)
            this.createButton(8, 'S6', SINGLE)
          }
        }
        this.type = {
          key: 'buttonevent',
          homekitValue: function (v) { return Math.floor(v / 1000) },
          homekitAction: hkZLLSwitchAction
        }
      } else {
        this.log.warn(
          '%s: %s: warning: ignoring unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      break
    case 'CLIPSwitch': // 2.1
      // We'd need a way to specify the number of buttons, cf. max value for
      // a CLIPGenericStatus sensor.
      this.log.warn(
        '%s: %s: warning: ignoring unsupported sensor type %s',
        this.bridge.name, this.resource, this.obj.type
      )
      break
    case 'ZLLPresence':
      this.duration = 0
      // falls through
    case 'ZHAPresence':
      if (
        this.obj.manufacturername === 'Philips' &&
        this.obj.modelid === 'SML001'
      ) {
        // 1.3 - Hue motion sensor
        durationKey = 'delay'
        readonlySensitivity = false
      } else if (
        this.obj.manufacturername === 'IKEA of Sweden' &&
        this.obj.modelid === 'TRADFRI motion sensor'
      ) {
        // Ikea Trådfri motion sensor
        this.obj.state.dark = false
      } else if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.sensor_motion' ||
          this.obj.modelid === 'lumi.sensor_motion.aq2'
        )
      ) {
        // Xiaomi motion sensor
        // Xiaomi Aqara motion sensor
      } else if (
        this.obj.manufacturername === 'Heiman' &&
        this.obj.modelid === 'PIR_TPV11'
      ) {
        // Heiman motion sensor
      } else if (
        this.obj.manufacturername === 'SmartThings' &&
        this.obj.modelid === 'tagv4'
      ) {
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPPresence': // 2.3
    case 'Geofence': // Undocumented
      this.service = new eve.Service.MotionSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.MotionDetected,
        key: 'presence',
        name: 'motion',
        unit: '',
        history: 'motion',
        homekitValue: function (v) { return v ? 1 : 0 },
        durationKey: durationKey,
        readonlySensitivity: readonlySensitivity
      }
      break
    case 'ZLLTemperature':
    case 'ZHATemperature':
      if (
        this.obj.manufacturername === 'Philips' &&
        this.obj.modelid === 'SML001'
      ) {
        // 1.4 - Hue motion sensor
      } else if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.weather' ||
          this.obj.modelid === 'lumi.sensor_ht'
        )
      ) {
        // Xiaomi temperature/humidity sensor
        // Xiaomi Aqara weather sensor
      } else if (
        this.obj.manufacturername === 'Heiman' &&
        (this.obj.modelid === 'TH-H_V15' || this.obj.modelid === 'TH-T_V15')
      ) {
        // Heiman temperature/humidity sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPTemperature': // 2.4
      this.service = new eve.Service.TemperatureSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.CurrentTemperature,
        props: { minValue: -40.0, maxValue: 100.0 },
        key: 'temperature',
        name: 'temperature',
        unit: '°C',
        history: 'weather',
        homekitValue: function (v) { return v ? Math.round(v / 10) / 10 : 0 }
      }
      break
    case 'ZLLLightLevel': // 2.7 - Hue Motion Sensor
    case 'ZHALightLevel':
      if (
        this.obj.manufacturername === 'Philips' &&
        this.obj.modelid === 'SML001'
      ) {
        // 1.4 - Hue motion sensor
      } else if (
        this.obj.manufacturername === 'LUMI' &&
        this.obj.modelid === 'lumi.sensor_motion.aq2'
      ) {
        // Xiaomi Aqara motion sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPLightLevel': // 2.7
      this.service = new Service.LightSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.CurrentAmbientLightLevel,
        key: 'lightlevel',
        name: 'light level',
        unit: ' lux',
        homekitValue: hkLightLevel
      }
      break
    case 'ZHAOpenClose':
      if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.sensor_magnet.aq2' ||
          this.obj.modelid === 'lumi.sensor_magnet'
        )
      ) {
        // Xiaomi Aqara door/window sensor
        // Xiaomi Mi door/window sensor
      } else if (
        this.obj.manufacturername === 'Heiman' &&
        this.obj.modelid === 'DOOR_TPV13'
      ) {
        // Heiman smart door sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPOpenClose': // 2.2
      this.service = new eve.Service.ContactSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.ContactSensorState,
        key: 'open',
        name: 'contact',
        unit: '',
        history: 'door',
        homekitValue: function (v) { return v ? 1 : 0 }
      }
      break
    case 'ZHAHumidity':
      if (
        this.obj.manufacturername === 'LUMI' && (
          this.obj.modelid === 'lumi.weather' ||
          this.obj.modelid === 'lumi.sensor_ht'
        )
      ) {
        // Xiaomi Aqara weather sensor
        // Xiaomi Mi temperature/humidity sensor
      } else if (
        this.obj.manufacturername === 'Heiman' &&
        (this.obj.modelid === 'TH-H_V15' || this.obj.modelid === 'TH-T_V15')
      ) {
        // Heiman temperature/humidity sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPHumidity': // 2.5
      this.service = new Service.HumiditySensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.CurrentRelativeHumidity,
        key: 'humidity',
        name: 'humidity',
        unit: '%',
        history: 'weather',
        homekitValue: function (v) { return v ? Math.round(v / 100) : 0 }
      }
      break
    case 'ZHAPressure':
      if (
        this.obj.manufacturername === 'LUMI' &&
        this.obj.modelid === 'lumi.weather'
      ) {
        // Xiaomi Aqara weather sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPPressure':
      this.service = new eve.Service.AirPressureSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: eve.Characteristic.AirPressure,
        key: 'pressure',
        name: 'pressure',
        unit: ' hPa',
        history: 'weather',
        homekitValue: function (v) { return v ? Math.round(v) : 0 }
      }
      this.service.updateCharacteristic(eve.Characteristic.Elevation, 0)
      break
    case 'ZHAAlarm':
      if (
        this.obj.manufacturername === 'Heiman' &&
        this.obj.modelid === 'WarningDevice'
      ) {
        // Heiman Siren
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPAlarm':
      this.service = new my.Service.Resource(this.name, this.subtype)
      this.service.addOptionalCharacteristic(my.Characteristic.Alarm)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: my.Characteristic.Alarm,
        key: 'alarm',
        name: 'alarm',
        homekitValue: function (v) { return v ? 1 : 0 }
      }
      break
    case 'ZHACarbonMonoxide':
      if (
        this.obj.manufacturername === 'Heiman' &&
        this.obj.modelid === 'CO_V16'
      ) {
        // Heiman CO sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPCarbonMonoxide':
      this.service = new Service.CarbonMonoxideSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.CarbonMonoxideDetected,
        key: 'carbonmonoxide',
        name: 'CO',
        unit: '',
        homekitValue: function (v) { return v ? 1 : 0 }
      }
      break
    case 'ZHAFire':
      if (
        this.obj.manufacturername === 'Heiman' &&
        (this.obj.modelid === 'SMOK_V16' || this.obj.modelid === 'GAS_V15')
      ) {
        // Heiman fire sensor
        // Heiman gas sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPFire':
      this.service = new Service.SmokeSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.SmokeDetected,
        key: 'fire',
        name: 'smoke',
        unit: '',
        homekitValue: function (v) { return v ? 1 : 0 }
      }
      break
    case 'ZHAWater':
      if (
        (
          this.obj.manufacturername === 'LUMI' &&
          this.obj.modelid === 'lumi.sensor_wleak.aq1'
        ) || (
          this.obj.manufacturername === 'Heiman' &&
          this.obj.modelid === 'WATER_TPV11'
        )
      ) {
        // Xiaomi Aqara flood sensor
        // Heiman water sensor
      } else {
        this.log.warn(
          '%s: %s: warning: unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      // falls through
    case 'CLIPWater':
      this.service = new Service.LeakSensor(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.LeakDetected,
        key: 'water',
        name: 'leak',
        unit: '',
        homekitValue: function (v) { return v ? 1 : 0 }
      }
      break
    case 'ZHAConsumption':
      // falls through
    case 'CLIPConsumption':
      this.service = new my.Service.Resource(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.service
        .addOptionalCharacteristic(eve.Characteristic.TotalConsumption)
      this.type = {
        Characteristic: eve.Characteristic.TotalConsumption,
        key: 'consumption',
        name: 'total consumption',
        unit: ' kWh',
        history: 'energy',
        homekitValue: function (v) { return v / 1000.0 }
      }
      break
    case 'ZHAPower':
      // falls through
    case 'CLIPPower':
      this.service = new my.Service.Resource(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.service
        .addOptionalCharacteristic(eve.Characteristic.CurrentConsumption)
      this.type = {
        Characteristic: eve.Characteristic.CurrentConsumption,
        key: 'power',
        name: 'current consumption',
        unit: ' W',
        history: 'energy',
        homekitValue: function (v) { return v }
      }
      break
    case 'ZHAThermostat':
      // falls through
    case 'CLIPThermostat':
      this.service = new Service.Thermostat(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.CurrentTemperature,
        // props: { minValue: -40.0, maxValue: 100.0 },
        key: 'temperature',
        name: 'temperature',
        unit: '°C',
        history: 'thermo',
        homekitValue: function (v) { return v ? Math.round(v / 10) / 10 : 0 }
      }
      break
    case 'Daylight':
      if (
        this.obj.manufacturername === 'Philips' &&
        this.obj.modelid === 'PHDL00'
      ) {
        // 2.6 - Built-in daylight sensor.
        if (!this.obj.config.configured) {
          this.log.warn(
            '%s: %s: warning: %s sensor not configured',
            this.bridge.name, this.resource, this.obj.type
          )
        }
        this.manufacturer = this.obj.manufacturername
        this.model = this.obj.modelid
        this.service = new Service.LightSensor(this.name, this.subtype)
        this.serviceList.push(this.service)
        this.type = {
          Characteristic: Characteristic.CurrentAmbientLightLevel,
          key: 'lightlevel',
          name: 'light level',
          unit: ' lux',
          homekitValue: hkLightLevel
        }
        if (obj.state.status == null) {
          // Hue bridge
          obj.state.lightlevel = obj.state.daylight ? 65535 : 0
          obj.state.dark = !obj.state.daylight
        }
        obj.config.reachable = obj.config.configured
      } else {
        this.log.warn(
          '%s: %s: warning: ignoring unknown %s sensor %j',
          this.bridge.name, this.resource, this.obj.type, this.obj
        )
      }
      break
    case 'CLIPGenericFlag': // 2.8
      this.service = new Service.Switch(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: Characteristic.On,
        key: 'flag',
        name: 'on',
        unit: '',
        homekitValue: function (v) { return v ? 1 : 0 },
        bridgeValue: function (v) { return !!v },
        setter: true
      }
      // Note that Eve handles a read-only switch correctly, but Home doesn't.
      if (
        this.obj.manufacturername === 'homebridge-hue' &&
        this.obj.modelid === 'CLIPGenericFlag' &&
        this.obj.swversion === '0'
      ) {
        this.type.props = {
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        }
      }
      break
    case 'CLIPGenericStatus': // 2.9
      this.service = new my.Service.Status(this.name, this.subtype)
      this.serviceList.push(this.service)
      this.type = {
        Characteristic: my.Characteristic.Status,
        key: 'status',
        name: 'status',
        unit: '',
        homekitValue: function (v) {
          return v > 127 ? 127 : v < -127 ? -127 : v
        },
        bridgeValue: function (v) { return v },
        setter: true
      }
      if (
        this.obj.manufacturername === 'homebridge-hue' &&
        this.obj.modelid === 'CLIPGenericStatus'
      ) {
        let min = parseInt(obj.swversion.split(',')[0])
        let max = parseInt(obj.swversion.split(',')[1])
        let step = parseInt(obj.swversion.split(',')[2])
        // Eve 3.1 displays the following controls, depending on the properties:
        // 1. {minValue: 0, maxValue: 1, minStep: 1}                    switch
        // 2. {minValue: a, maxValue: b, minStep: 1}, 1 < b - a <= 20   down|up
        // 3. {minValue: a, maxValue: b}, (a, b) != (0, 1)              slider
        // 4. {minValue: a, maxValue: b, minStep: 1}, b - a > 20        slider
        // Avoid the following bugs:
        // 5. {minValue: 0, maxValue: 1}                                nothing
        // 6. {minValue: a, maxValue: b, minStep: 1}, b - a = 1         switch*
        //    *) switch sends values 0 and 1 instead of a and b;
        if (min === 0 && max === 0) {
          this.type.props = {
            perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
          }
        } else if (min >= -127 && max <= 127 && min < max) {
          if (min === 0 && max === 1) {
            // Workaround Eve bug (case 5 above).
            this.type.props = { minValue: min, maxValue: max, minStep: 1 }
          } else if (max - min === 1) {
            // Workaround Eve bug (case 6 above).
            this.type.props = { minValue: min, maxValue: max }
          } else if (step !== 1) {
            // Default to slider for backwards compatibility.
            this.type.props = { minValue: min, maxValue: max }
          } else {
            this.type.props = { minValue: min, maxValue: max, minStep: 1 }
          }
        }
        this.log.debug(
          '%s: %s: props: %j', this.bridge.name,
          this.resource, this.type.props
        )
      }
      break
    default:
      this.log.warn(
        '%s: %s: warning: ignoring unknown sensor type %j',
        this.bridge.name, this.resource, this.obj
      )
      break
  }

  if (this.service) {
    if (this.type.Characteristic) {
      const char = this.service.getCharacteristic(this.type.Characteristic)
      if (this.type.props) {
        char.setProps(this.type.props)
      }
      if (this.type.setter) {
        char.on('set', this.setValue.bind(this))
      }
      if (this.type.history != null) {
        this.historyService = this.accessory
          .getHistoryService(this.type.history, this)
        this.history = this.accessory.history
        if (this.type.history !== this.history.type) {
          // History service already used for other type.
          this.historyService = null
          this.history = null
          this.type.history = null
        }
        const now = moment().unix()
        const epoch = moment('2001-01-01T00:00:00Z').unix()
        switch (this.type.history) {
          case 'door':
            this.hk.timesOpened = 0
            this.historyService
              .addOptionalCharacteristic(eve.Characteristic.ResetTotal)
            this.historyService.getCharacteristic(eve.Characteristic.ResetTotal)
              .setValue(now - epoch)
              .on('set', (value, callback) => {
                this.hk.timesOpened = 0
                this.service.updateCharacteristic(
                  eve.Characteristic.TimesOpened, this.hk.timesOpened
                )
                callback(null)
              })
            // falls through
          case 'motion':
            this.history.entry.status = 0
            break
          case 'energy':
            this.service
              .addOptionalCharacteristic(eve.Characteristic.TotalConsumption)
            this.service
              .addOptionalCharacteristic(eve.Characteristic.CurrentConsumption)
            if (this.history.resource.type.key === 'power') {
              this.history.consumption = 0
              this.history.totalConsumption = 0
              this.historyService
                .addOptionalCharacteristic(eve.Characteristic.ResetTotal)
              this.historyService
                .getCharacteristic(eve.Characteristic.ResetTotal)
                .setValue(now - epoch)
                .on('set', (value, callback) => {
                  this.history.totalConsumption = 0
                  this.service.updateCharacteristic(
                    eve.Characteristic.TotalConsumption,
                    this.history.totalConsumption
                  )
                  callback(null)
                })
            }
            this.history.entry.power = 0
            break
          case 'thermo':
            this.history.entry.currentTemp = 0
            this.history.entry.setTemp = 0
            this.history.entry.valvePosition = 0
            break
          case 'weather':
            this.history.entry.temp = 0
            this.history.entry.humidity = 0
            this.history.entry.pressure = 0
            break
          default:
            break
        }
      }
      this.checkValue(this.obj.state[this.type.key])
    }
    this.service.addOptionalCharacteristic(my.Characteristic.LastUpdated)
    this.checkLastupdated(this.obj.state.lastupdated)
    if (this.obj.state.dark !== undefined) {
      this.service.addOptionalCharacteristic(my.Characteristic.Dark)
      this.checkDark(this.obj.state.dark)
    }
    if (this.obj.state.daylight !== undefined) {
      this.service.addOptionalCharacteristic(my.Characteristic.Daylight)
      this.checkDaylight(this.obj.state.daylight)
    }
    if (this.obj.state.tampered !== undefined) {
      this.service.addOptionalCharacteristic(Characteristic.StatusTampered)
      this.checkTampered(this.obj.state.tampered)
    }
    if (this.obj.state.current !== undefined) {
      this.service.addOptionalCharacteristic(eve.Characteristic.ElectricCurrent)
      this.checkCurrent(this.obj.state.current)
    }
    if (this.obj.state.voltage !== undefined) {
      this.service.addOptionalCharacteristic(eve.Characteristic.Voltage)
      this.checkVoltage(this.obj.state.voltage)
    }
    if (this.obj.state.on !== undefined) {
      this.checkStateOn(this.obj.state.on)
    }
    if (
      this.obj.state.daylight !== undefined &&
      this.obj.state.status !== undefined
    ) {
      this.service.addOptionalCharacteristic(my.Characteristic.Status)
      this.service.getCharacteristic(my.Characteristic.Status)
        .setProps({
          minValue: 100,
          maxValue: 230,
          perms: [Characteristic.Perms.READ, Characteristic.Perms.NOTIFY]
        })
      this.service.addOptionalCharacteristic(my.Characteristic.LastEvent)
      this.service.addOptionalCharacteristic(my.Characteristic.Period)
      this.checkStatus(this.obj.state.status)
    }
    if (this.obj.config[this.type.durationKey] !== undefined) {
      this.checkDuration(this.obj.config[this.type.durationKey])
      this.service.getCharacteristic(eve.Characteristic.Duration)
        .on('set', this.setDuration.bind(this))
    }
    if (this.duration !== undefined) {
      // Add fake duration for Hue motion sensor connected to the Hue bridge
      this.hk.duration = 5
      this.service.getCharacteristic(eve.Characteristic.Duration)
        .setValue(this.hk.duration)
        .on('set', this.setDuration.bind(this))
    }
    if (
      this.obj.config.sensitivity !== undefined &&
      this.obj.type !== 'ZHASwitch'
    ) {
      this.checkSensitivity(this.obj.config.sensitivity)
      if (!this.type.readonlySensitivity) {
        this.service.getCharacteristic(eve.Characteristic.Sensitivity)
          .on('set', this.setSensitivity.bind(this))
      }
    }
    if (this.obj.config.offset !== undefined) {
      this.service.addOptionalCharacteristic(my.Characteristic.Offset)
      this.checkOffset(this.obj.config.offset)
      this.service.getCharacteristic(my.Characteristic.Offset)
        .on('set', this.setOffset.bind(this))
    }
    if (this.obj.config.heatsetpoint !== undefined) {
      this.checkHeatSetPoint(this.obj.config.heatsetpoint)
      this.service.getCharacteristic(Characteristic.TargetTemperature)
        .on('set', this.setTargetTemperature.bind(this))
    }
    if (this.obj.config.scheduleron !== undefined) {
      this.checkSchedulerOn(this.obj.config.scheduleron)
      this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .setProps({ maxValue: Characteristic.TargetHeatingCoolingState.HEAT })
        .on('set', this.setTargetHeatingCoolingState.bind(this))
    }
    this.service.addOptionalCharacteristic(Characteristic.StatusFault)
    this.checkReachable(this.obj.config.reachable)
    this.service.addOptionalCharacteristic(Characteristic.StatusActive)
    this.service.addOptionalCharacteristic(my.Characteristic.Enabled)
    this.checkOn(this.obj.config.on)
    this.service.getCharacteristic(my.Characteristic.Enabled)
      .on('set', this.setEnabled.bind(this))
    if (this.bridge.platform.config.resource) {
      this.service.addOptionalCharacteristic(my.Characteristic.Resource)
      this.service.getCharacteristic(my.Characteristic.Resource)
        .updateValue(this.resource)
    }
  }
  if (this.obj.config.battery !== undefined) {
    this.batteryService = this.accessory.getBatteryService(
      this.obj.config.battery
    )
  }
}

HueSensor.prototype.createLabel = function (labelNamespace) {
  this.service = this.accessory.getLabelService(labelNamespace)
  this.buttonMap = {}
}

HueSensor.prototype.createButton = function (buttonIndex, buttonName, props) {
  const service = new Service.StatelessProgrammableSwitch(
    this.name + ' ' + buttonName, buttonName
  )
  this.serviceList.push(service)
  this.buttonMap['' + buttonIndex] = service
  service.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
    .setProps(props)
  service.getCharacteristic(Characteristic.ServiceLabelIndex)
    .setValue(buttonIndex)
}

// ===== Bridge Events =========================================================

HueSensor.prototype.heartbeat = function (beat, obj) {
  if (
    obj.state.daylight != null &&
    obj.state.lightlevel == null && obj.state.status == null
  ) {
    // Daylight sensor on Hue bridge.
    obj.state.lightlevel = obj.state.daylight ? 65535 : 0
    obj.state.dark = !obj.state.daylight
  }
  this.checkState(obj.state, false)
  if (obj.config.configured != null && obj.config.reachable == null) {
    obj.config.reachable = obj.config.configured
  }
  this.checkConfig(obj.config, false)
}

HueSensor.prototype.checkState = function (state, event) {
  for (const key in state) {
    switch (key) {
      case 'buttonevent':
        this.checkButtonevent(state.buttonevent, state.lastupdated, event)
        break
      case 'current':
        this.checkCurrent(state.current)
        break
      case 'dark':
        this.checkDark(state.dark)
        break
      case 'daylight':
        this.checkDaylight(state.daylight)
        break
      case 'lastupdated':
        this.checkLastupdated(state.lastupdated)
        break
      case 'lowbattery':
        break
      case 'lux':
        break
      case 'on':
        this.checkStateOn(state.on)
        break
      case 'tampered':
        this.checkTampered(state.tampered)
        break
      case 'voltage':
        this.checkVoltage(state.voltage)
        break
      default:
        if (key === this.type.key) {
          this.checkValue(state[this.type.key])
        } else if (key === 'status') {
          this.checkStatus(state.status)
        } else if (key === 'power') {
          // this.checkPower(state.power)
        } else {
          this.log.debug(
            '%s: ignore unknown attribute state.%s', this.name, key
          )
        }
        break
    }
  }
}

HueSensor.prototype.checkValue = function (value) {
  if (this.obj.state[this.type.key] !== value) {
    this.log.debug(
      '%s: sensor %s changed from %j to %j', this.name,
      this.type.key, this.obj.state[this.type.key], value
    )
    this.obj.state[this.type.key] = value
  }
  const hkValue = this.type.homekitValue(this.obj.state[this.type.key])
  if (this.durationTimer != null) {
    if (hkValue !== 0) {
      clearTimeout(this.durationTimer)
      this.durationTimer = null
      this.log.debug(
        '%s: cancel timer to keep homekit %s on %s%s for %ss', this.name,
        this.type.name, hkValue, this.type.unit, this.hk.duration
      )
    }
    return
  }
  if (this.hk[this.type.key] !== hkValue) {
    if (this.duration > 0 && hkValue === 0) {
      this.log.debug(
        '%s: keep homekit %s on %s%s for %ss', this.name, this.type.name,
        this.hk[this.type.key], this.type.unit, this.hk.duration
      )
      const saved = {
        oldValue: this.hk[this.type.key],
        value: hkValue,
        duration: this.hk.duration
      }
      this.durationTimer = setTimeout(() => {
        this.log.info(
          '%s: set homekit %s from %s%s to %s%s, after %ss',
          this.name, this.type.name, saved.oldValue, this.type.unit,
          saved.value, this.type.unit, saved.duration
        )
        this.durationTimer = null
        this.hk[this.type.key] = saved.value
        this.service
          .updateCharacteristic(this.type.Characteristic, this.hk[this.type.key])
        this.addEntry(true)
      }, this.duration * 1000)
      return
    }
    if (this.hk[this.type.key] !== undefined) {
      this.log.info(
        '%s: set homekit %s from %s%s to %s%s', this.name,
        this.type.name, this.hk[this.type.key], this.type.unit,
        hkValue, this.type.unit
      )
    }
    this.hk[this.type.key] = hkValue
    this.service
      .updateCharacteristic(this.type.Characteristic, this.hk[this.type.key])
    this.addEntry(true)
  }
}

HueSensor.prototype.addEntry = function (changed) {
  if (this.history == null) {
    return
  }
  const initialising = this.history.entry.time == null
  const now = moment().unix()
  this.history.entry.time = now
  switch (this.history.type) {
    case 'door':
      if (changed) {
        this.hk.timesOpened += this.hk[this.type.key]
        this.service.updateCharacteristic(
          eve.Characteristic.TimesOpened, this.hk.timesOpened
        )
      }
      // falls through
    case 'motion':
      if (changed) {
        this.hk.lastActivation = now - this.historyService.getInitialTime()
        this.service.updateCharacteristic(
          eve.Characteristic.LastActivation, this.hk.lastActivation
        )
      }
      this.history.entry.status = this.hk[this.type.key]
      break
    case 'energy':
      if (this.history.resource.type.key === 'power') {
        if (!initialising) {
          const delta = this.history.power * (now - this.history.time) // Ws
          this.history.consumption += Math.round(delta / 600.0) // W * 10 min
          this.history.totalConsumption += Math.round(delta / 3600.0) // Wh
        }
        this.history.power = this.hk.power
        this.history.time = now
      }
      if (changed || this.type.key !== this.history.resource.type.key) {
        return
      }
      if (this.history.resource.type.key === 'power') {
        this.history.entry.power = this.history.consumption
        this.history.consumption = 0
        this.log.info(
          '%s: set homekit total consumption to %s kWh', this.name,
          this.history.totalConsumption / 1000 // kWh
        )
        this.service.updateCharacteristic(
          eve.Characteristic.TotalConsumption, this.history.totalConsumption
        )
      } else {
        if (this.history.consumption != null) {
          const delta = this.obj.state.consumption -
                        this.history.consumption // Wh
          this.history.entry.power = delta * 6 // W * 10 min
          if (!this.accessory.resources.sensors.Power) {
            this.log.info(
              '%s: set homekit current consumption to %s W', this.name,
              this.hk.current, delta
            )
            this.service.updateCharacteristic(
              eve.Characteristic.CurrentConsumption, this.history.entry.power
            )
          }
        }
        this.history.consumption = this.obj.state.consumption
      }
      break
    case 'thermo':
      this.history.entry.currentTemp = this.hk.temperature
      this.history.entry.setTemp = this.hk.targetTemperature
      this.history.entry = Object.assign({}, this.history.entry)
      if (changed) {
        return
      }
      break
    case 'weather':
      const key = this.type.key === 'temperature' ? 'temp' : this.type.key
      this.history.entry[key] = this.hk[this.type.key]
      if (changed || this.type.key !== this.history.resource.type.key) {
        return
      }
      break
    default:
      return
  }
  if (initialising) {
    return
  }
  setTimeout(() => {
    // Make sure all weather entry attributes have been updated
    this.log.debug('%s: add history entry %j', this.name, this.history.entry)
    this.historyService.addEntry(this.history.entry)
  }, 0)
}

HueSensor.prototype.checkButtonevent = function (
  buttonevent, lastupdated, event
) {
  if (event || this.obj.state.lastupdated !== lastupdated) {
    this.log.debug(
      '%s: sensor buttonevent %j on %s', this.name,
      buttonevent, this.obj.state.lastupdated
    )
    const buttonIndex = this.type.homekitValue(buttonevent)
    const action = this.type.homekitAction(
      buttonevent, this.obj.state.buttonevent, this.repeat
    )
    this.obj.state.buttonevent = buttonevent
    if (
      buttonIndex != null && action != null &&
      this.buttonMap[buttonIndex] != null
    ) {
      this.log.info(
        '%s: homekit button %s', this.buttonMap[buttonIndex].displayName,
        { 0: 'single press', 1: 'double press', 2: 'long press' }[action]
      )
      this.buttonMap[buttonIndex]
        .updateCharacteristic(Characteristic.ProgrammableSwitchEvent, action)
    }
  }
}

HueSensor.prototype.checkCurrent = function (current) {
  if (this.obj.state.current !== current) {
    this.log.debug(
      '%s: current changed from %s to %s', this.name,
      this.obj.state.current, current
    )
    this.obj.state.current = current
  }
  const hkCurrent = this.obj.state.current / 1000.0
  if (this.hk.current !== hkCurrent) {
    if (this.hk.current !== undefined) {
      this.log.info(
        '%s: set homekit electric current from %s A to %s A', this.name,
        this.hk.current, hkCurrent
      )
    }
    this.hk.current = hkCurrent
    this.service.getCharacteristic(eve.Characteristic.ElectricCurrent)
      .updateValue(this.hk.current)
  }
}

HueSensor.prototype.checkDark = function (dark) {
  if (this.obj.state.dark !== dark) {
    this.log.debug(
      '%s: sensor dark changed from %j to %j', this.name,
      this.obj.state.dark, dark
    )
    this.obj.state.dark = dark
  }
  const hkDark = this.obj.state.dark ? 1 : 0
  if (this.hk.dark !== hkDark) {
    if (this.hk.dark !== undefined) {
      this.log.info(
        '%s: set homekit dark from %s to %s', this.name,
        this.hk.dark, hkDark
      )
    }
    this.hk.dark = hkDark
    this.service
      .updateCharacteristic(my.Characteristic.Dark, this.hk.dark)
  }
}

HueSensor.prototype.checkDaylight = function (daylight) {
  if (this.obj.state.daylight !== daylight) {
    this.log.debug(
      '%s: sensor daylight changed from %j to %j', this.name,
      this.obj.state.daylight, daylight
    )
    this.obj.state.daylight = daylight
  }
  const hkDaylight = this.obj.state.daylight ? 1 : 0
  if (this.hk.daylight !== hkDaylight) {
    if (this.hk.daylight !== undefined) {
      this.log.info(
        '%s: set homekit daylight from %s to %s', this.name,
        this.hk.daylight, hkDaylight
      )
    }
    this.hk.daylight = hkDaylight
    this.service
      .updateCharacteristic(my.Characteristic.Daylight, this.hk.daylight)
  }
}

HueSensor.prototype.checkLastupdated = function (lastupdated) {
  if (this.obj.state.lastupdated !== lastupdated) {
    // this.log.debug(
    //   '%s: sensor lastupdated changed from %s to %s', this.name,
    //   this.obj.state.lastupdated, lastupdated
    // );
    this.obj.state.lastupdated = lastupdated
  }
  const hkLastupdated =
    (this.obj.state.lastupdated && this.obj.state.lastupdated !== 'none')
      ? String(new Date(this.obj.state.lastupdated + 'Z')).substring(0, 24) : 'n/a'
  if (this.hk.lastupdated !== hkLastupdated) {
    // this.log.info(
    //   '%s: set homekit last updated from %s to %s', this.name,
    //   this.hk.lastupdated, hkLastupdated
    // );
    this.hk.lastupdated = hkLastupdated
    this.service
      .updateCharacteristic(my.Characteristic.LastUpdated, hkLastupdated)
  }
}

HueSensor.prototype.checkStatus = function (status) {
  if (this.obj.state.status !== status) {
    this.log.debug(
      '%s: sensor status changed from %j to %j', this.name,
      this.obj.state.status, status
    )
    this.obj.state.status = status
  }
  const hkStatus = this.obj.state.status
  if (this.hk.status !== hkStatus) {
    if (this.hk.status !== undefined) {
      this.log.info(
        '%s: set homekit status from %s to %s', this.name,
        this.hk.status, hkStatus
      )
    }
    this.hk.status = hkStatus
    this.service
      .updateCharacteristic(my.Characteristic.Status, this.hk.status)
  }
  const daylightEvent = daylightEvents[this.obj.state.status]
  const period = daylightPeriods[daylightEvent.period]
  this.checkValue(period.lightlevel)
  const hkEvent = daylightEvent.name
  if (this.hk.event !== hkEvent) {
    if (this.hk.event !== undefined) {
      this.log.info(
        '%s: set homekit last event from %s to %s', this.name,
        this.hk.event, hkEvent
      )
    }
    this.hk.event = hkEvent
    this.service
      .updateCharacteristic(my.Characteristic.LastEvent, this.hk.event)
  }
  const hkPeriod = daylightEvent.period
  if (this.hk.period !== hkPeriod) {
    if (this.hk.period !== undefined) {
      this.log.info(
        '%s: set homekit period from %s to %s', this.name,
        this.hk.period, hkPeriod
      )
    }
    this.hk.period = hkPeriod
    this.service
      .updateCharacteristic(my.Characteristic.Period, this.hk.period)
  }
}

HueSensor.prototype.checkStateOn = function (on) {
  if (this.obj.state.on !== on) {
    this.log.debug(
      '%s: sensor on changed from %j to %j', this.name,
      this.obj.state.on, on
    )
    this.obj.state.on = on
  }
  const hkCurrentHeatingCoolingState = on
    ? Characteristic.CurrentHeatingCoolingState.HEAT
    : Characteristic.CurrentHeatingCoolingState.OFF
  if (this.hk.currentHeatingCoolingState !== hkCurrentHeatingCoolingState) {
    if (this.hk.currentHeatingCoolingState !== undefined) {
      this.log.info(
        '%s: set homekit current heating cooling state from %s to %s', this.name,
        this.hk.currentHeatingCoolingState, hkCurrentHeatingCoolingState
      )
    }
    this.hk.currentHeatingCoolingState = hkCurrentHeatingCoolingState
    this.service.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      this.hk.currentHeatingCoolingState
    )
  }
}

HueSensor.prototype.checkTampered = function (tampered) {
  if (this.obj.state.tampered !== tampered) {
    this.log.debug(
      '%s: sensor tampered changed from %j to %j', this.name,
      this.obj.state.tampered, tampered
    )
    this.obj.state.tampered = tampered
  }
  const hkTampered = this.obj.state.tampered ? 1 : 0
  if (this.hk.tampered !== hkTampered) {
    if (this.hk.tampered !== undefined) {
      this.log.info(
        '%s: set homekit status tampered from %s to %s', this.name,
        this.hk.tampered, hkTampered
      )
    }
    this.hk.tampered = hkTampered
    this.service
      .updateCharacteristic(Characteristic.StatusTampered, this.hk.tampered)
  }
}

HueSensor.prototype.checkVoltage = function (voltage) {
  if (this.obj.state.voltage !== voltage) {
    this.log.debug(
      '%s: voltage changed from %s to %s', this.name,
      this.obj.state.voltage, voltage
    )
    this.obj.state.voltage = voltage
  }
  const hkVoltage = this.obj.state.voltage
  if (this.hk.voltage !== hkVoltage) {
    if (this.hk.voltage !== undefined) {
      this.log.info(
        '%s: set homekit voltage from %s V to %s V', this.name,
        this.hk.voltage, hkVoltage
      )
    }
    this.hk.voltage = hkVoltage
    this.service.getCharacteristic(eve.Characteristic.Voltage)
      .updateValue(this.hk.voltage)
  }
}

HueSensor.prototype.checkConfig = function (config) {
  for (const key in config) {
    switch (key) {
      case 'alert':
        break
      case 'battery':
        this.accessory.checkBattery(config.battery)
        break
      case 'configured':
        break
      case 'delay':
        if (this.type.durationKey === 'delay') {
          this.checkDuration(config.delay)
        }
        break
      case 'duration':
        this.checkDuration(config.duration)
        break
      case 'group':
        break
      case 'heatsetpoint':
        this.checkHeatSetPoint(config.heatsetpoint)
        break
      case 'ledindication':
        break
      case 'mode':
        break
      case 'offset':
        this.checkOffset(config.offset)
        break
      case 'on':
        this.checkOn(config.on)
        break
      case 'pending':
        break
      case 'reachable':
        this.checkReachable(config.reachable)
        break
      case 'scheduler':
        break
      case 'scheduleron':
        this.checkSchedulerOn(config.scheduleron)
        break
      case 'sensitivity':
        this.checkSensitivity(config.sensitivity)
        break
      case 'sensitivitymax':
        break
      case 'sunriseoffset':
        break
      case 'sunsetoffset':
        break
      case 'temperature':
        break
      case 'tholddark':
        break
      case 'tholdoffset':
        break
      case 'usertest':
        break
      default:
        this.log.debug(
          '%s: ignore unknown attribute config.%s', this.name, key
        )
        break
    }
  }
}

HueSensor.prototype.checkBattery = function (battery) {
  if (this.obj.config.battery !== battery) {
    this.log.debug(
      '%s: sensor battery changed from %j to %j', this.name,
      this.obj.config.battery, battery
    )
    this.obj.config.battery = battery
  }
  const hkBattery = toInt(battery, 0, 100)
  if (this.hk.battery !== hkBattery) {
    if (this.hk.battery !== undefined) {
      this.log.info(
        '%s: set homekit battery level from %s%% to %s%%', this.name,
        this.hk.battery, hkBattery
      )
    }
    this.hk.battery = hkBattery
    this.hk.lowBattery =
      this.hk.battery <= this.bridge.platform.config.lowBattery
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
    this.batteryService
      .updateCharacteristic(Characteristic.BatteryLevel, this.hk.battery)
      .updateCharacteristic(
        Characteristic.StatusLowBattery, this.hk.lowBattery
      )
  }
}

HueSensor.prototype.checkDuration = function (duration) {
  if (this.type.name !== 'motion') {
    // Workaround while IAS Zone sensors are exposed as ZHAPresence
    return
  }
  if (this.obj.config[this.type.durationKey] !== duration) {
    this.log.debug(
      '%s: sensor %s changed from %j to %j', this.name,
      this.type.durationKey, this.obj.config[this.type.durationKey], duration
    )
    this.obj.config[this.type.durationKey] = duration
  }
  const char = this.service.getCharacteristic(eve.Characteristic.Duration)
  let hkDuration
  for (const value of char.props.validValues) {
    hkDuration = value
    if (this.obj.config[this.type.durationKey] <= value) {
      break
    }
  }
  if (this.hk.duration !== hkDuration) {
    if (this.hk.duration !== undefined) {
      this.log.info(
        '%s: set homekit duration from %ss to %ss', this.name,
        this.hk.duration, hkDuration
      )
    }
    this.hk.duration = hkDuration
    this.service
      .updateCharacteristic(eve.Characteristic.Duration, this.hk.duration)
  }
}

HueSensor.prototype.checkHeatSetPoint = function (heatsetpoint) {
  if (this.obj.config.heatsetpoint !== heatsetpoint) {
    this.log.debug(
      '%s: sensor heatsetpoint changed from %j to %j', this.name,
      this.obj.config.heatsetpoint, heatsetpoint
    )
    this.obj.config.heatsetpoint = heatsetpoint
  }
  let hkTargetTemperature = Math.round(this.obj.config.heatsetpoint / 10) / 10
  if (this.hk.targetTemperature !== hkTargetTemperature) {
    if (this.hk.targetTemperature !== undefined) {
      this.log.info(
        '%s: set homekit target temperature from %s°C to %s°C', this.name,
        this.hk.targetTemperature, hkTargetTemperature
      )
    }
    this.hk.targetTemperature = hkTargetTemperature
    this.service.updateCharacteristic(
      Characteristic.TargetTemperature, this.hk.targetTemperature
    )
  }
}

HueSensor.prototype.checkOffset = function (offset) {
  if (this.obj.config.offset !== offset) {
    this.log.debug(
      '%s: sensor offset changed from %j to %j', this.name,
      this.obj.config.offset, offset
    )
    this.obj.config.offset = offset
  }
  let hkOffset = toInt(this.obj.config.offset, -500, 500)
  hkOffset = Math.round(hkOffset / 10) / 10
  if (this.hk.offset !== hkOffset) {
    if (this.hk.offset !== undefined) {
      this.log.info(
        '%s: set homekit offset from %s°C to %s°C', this.name,
        this.hk.offset, hkOffset
      )
    }
    this.hk.offset = hkOffset
    this.service
      .updateCharacteristic(my.Characteristic.Offset, this.hk.offset)
  }
}

HueSensor.prototype.checkOn = function (on) {
  if (this.obj.config.on !== on) {
    this.log.debug(
      '%s: sensor on changed from %j to %j', this.name,
      this.obj.config.on, on
    )
    this.obj.config.on = on
  }
  const hkEnabled = this.obj.config.on === false ? 0 : 1
  if (this.hk.enabled !== hkEnabled) {
    if (this.hk.enabled !== undefined) {
      this.log.info(
        '%s: set homekit enabled from %s to %s', this.name,
        this.hk.enabled, hkEnabled
      )
    }
    this.hk.enabled = hkEnabled
    this.service
      .updateCharacteristic(Characteristic.StatusActive, this.hk.enabled)
      .updateCharacteristic(my.Characteristic.Enabled, this.hk.enabled)
  }
}

HueSensor.prototype.checkReachable = function (reachable) {
  if (this.obj.config.reachable !== reachable) {
    this.log.debug(
      '%s: sensor reachable changed from %j to %j', this.name,
      this.obj.config.reachable, reachable
    )
    this.obj.config.reachable = reachable
  }
  const hkFault = this.obj.config.reachable === false ? 1 : 0
  if (this.hk.fault !== hkFault) {
    if (this.hk.fault !== undefined) {
      this.log.info(
        '%s: set homekit status fault from %s to %s', this.name,
        this.hk.fault, hkFault
      )
    }
    this.hk.fault = hkFault
    this.service.getCharacteristic(Characteristic.StatusFault)
      .updateValue(this.hk.fault)
  }
}

HueSensor.prototype.checkSchedulerOn = function (scheduleron) {
  if (this.obj.config.scheduleron !== scheduleron) {
    this.log.debug(
      '%s: sensor scheduleron changed from %j to %j', this.name,
      this.obj.config.scheduleron, scheduleron
    )
    this.obj.config.scheduleron = scheduleron
  }
  const hkTargetHeatingCoolingState = this.obj.config.scheduleron
    ? Characteristic.TargetHeatingCoolingState.HEAT
    : Characteristic.TargetHeatingCoolingState.OFF
  if (this.hk.targetHeatingCoolingState !== hkTargetHeatingCoolingState) {
    if (this.hk.targetHeatingCoolingState !== undefined) {
      this.log.info(
        '%s: set homekit target heating cooling state from %s to %s', this.name,
        this.hk.targetHeatingCoolingState, hkTargetHeatingCoolingState
      )
    }
    this.hk.targetHeatingCoolingState = hkTargetHeatingCoolingState
    this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .updateValue(this.hk.targetHeatingCoolingState)
  }
}

HueSensor.prototype.checkSensitivity = function (sensitivity) {
  if (this.obj.config.sensitivity == null || this.obj.type === 'ZHASwitch') {
    return
  }
  if (this.obj.config.sensitivity !== sensitivity) {
    this.log.debug(
      '%s: sensor sensitivity changed from %j to %j', this.name,
      this.obj.config.sensitivity, sensitivity
    )
    this.obj.config.sensitivity = sensitivity
  }
  const hkSensitivity = { 0: 7, 1: 4, 2: 0 }[sensitivity]
  if (this.hk.sensitivity !== hkSensitivity) {
    if (this.hk.sensitivity !== undefined) {
      this.log.info(
        '%s: set homekit sensitivity from %s to %s', this.name,
        this.hk.sensitivity, hkSensitivity
      )
    }
    this.hk.sensitivity = hkSensitivity
    this.service.updateCharacteristic(
      eve.Characteristic.Sensitivity, this.hk.sensitivity
    )
  }
}

// ===== Homekit Events ========================================================

HueSensor.prototype.identify = function (callback) {
  if (this.obj.config.alert === undefined) {
    return callback()
  }
  this.log.info('%s: identify', this.name)
  this.bridge.request('put', this.resource + '/config', { alert: 'select' })
    .then((obj) => {
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setValue = function (value, callback) {
  if (value === this.hk[this.type.key]) {
    return callback()
  }
  this.log.info(
    '%s: homekit %s changed from %s%s to %s%s', this.name,
    this.type.name, this.hk[this.type.key], this.type.unit, value, this.type.unit
  )
  this.hk[this.type.key] = value
  const newValue = this.type.bridgeValue(value)
  const body = {}
  body[this.type.key] = newValue
  this.bridge.request('put', this.resource + '/state', body)
    .then((obj) => {
      this.obj.state[this.type.key] = newValue
      this.value = newValue
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setDuration = function (duration, callback) {
  if (duration === this.hk.duration) {
    return callback()
  }
  this.log.info(
    '%s: homekit duration changed from %ss to %ss', this.name,
    this.hk.duration, duration
  )
  this.hk.duration = duration
  const hueDuration = duration === 5 ? 0 : duration
  if (this.duration !== undefined) {
    this.duration = hueDuration
    return callback()
  }
  const body = {}
  body[this.type.durationKey] = hueDuration
  this.bridge.request('put', this.resource + '/config', body)
    .then((obj) => {
      this.obj.config[this.type.durationKey] = hueDuration
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setEnabled = function (enabled, callback) {
  enabled = enabled ? 1 : 0
  if (enabled === this.hk.enabled) {
    return callback()
  }
  this.log.info(
    '%s: homekit enabled changed from %s to %s', this.name,
    this.hk.enabled, enabled
  )
  this.hk.enabled = enabled
  const on = !!this.hk.enabled
  this.bridge.request('put', this.resource + '/config', { on: on })
    .then((obj) => {
      this.obj.config.on = on
      this.service
        .updateCharacteristic(Characteristic.StatusActive, this.hk.enabled)
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setOffset = function (offset, callback) {
  if (offset === this.hk.offset) {
    return callback()
  }
  this.log.info(
    '%s: homekit offset changed from %s to %s', this.name,
    this.hk.offset, offset
  )
  this.hk.offset = offset
  const hueOffset = Math.round(offset * 100)
  this.bridge.request(
    'put', this.resource + '/config', { offset: hueOffset }
  )
    .then((obj) => {
      this.obj.config.offset = hueOffset
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setTargetHeatingCoolingState = function (
  targetHeatingCoolingState, callback
) {
  if (targetHeatingCoolingState === this.hk.targetHeatingCoolingState) {
    return callback()
  }
  this.log.info(
    '%s: homekit target heating cooling state changed from %s to %s', this.name,
    this.hk.targetHeatingCoolingState, targetHeatingCoolingState
  )
  this.hk.targetHeatingCoolingState = targetHeatingCoolingState
  const hueScheduleron =
    this.hk.targetHeatingCoolingState !== Characteristic.TargetHeatingCoolingState.OFF
  this.bridge.request(
    'put', this.resource + '/config', { scheduleron: hueScheduleron }
  )
    .then((obj) => {
      this.obj.config.scheduleron = hueScheduleron
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setTargetTemperature = function (targetTemperature, callback) {
  if (targetTemperature === this.hk.targetTemperature) {
    return callback()
  }
  this.log.info(
    '%s: homekit target temperature changed from %s to %s', this.name,
    this.hk.targetTemperature, targetTemperature
  )
  this.hk.targetTemperature = targetTemperature
  const hueHeatSetPoint = Math.round(targetTemperature * 100)
  this.bridge.request(
    'put', this.resource + '/config', { heatsetpoint: hueHeatSetPoint }
  )
    .then((obj) => {
      this.obj.config.heatsetpoint = hueHeatSetPoint
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}

HueSensor.prototype.setSensitivity = function (sensitivity, callback) {
  if (sensitivity === this.hk.sensitivity) {
    return callback()
  }
  this.log.info(
    '%s: homekit sensitivity changed from %s to %s', this.name,
    this.hk.sensitivity, sensitivity
  )
  this.hk.sensitivity = sensitivity
  const hueSensitivity = { 0: 2, 4: 1, 7: 0 }[sensitivity]
  this.bridge.request(
    'put', this.resource + '/config', { sensitivity: hueSensitivity }
  )
    .then((obj) => {
      this.obj.config.sensitivity = hueSensitivity
      return callback()
    }).catch((err) => {
      return callback(err)
    })
}
