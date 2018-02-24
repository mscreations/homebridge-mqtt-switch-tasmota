// Based off work by Jaromir Kopp @MacWyznawca.

let Service, Characteristic;
const mqtt = require('mqtt');

module.exports = homebridge => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory("homebridge-mqtt-switch-tasmota", "mqtt-switch-tasmota", MqttSwitchTasmotaAccessory);
}

class MqttSwitchTasmotaAccessory {
  constructor(log, loadedConfig) {
    const defualtConfig = {
      url: undefined,
      qos: 0,

      username: undefined,
      password: undefined,

      onValue:  "ON",
      offValue: "OFF",
      topics:   {},

      activityTopic: undefined,
      activityParameter: undefined,

      startCmd: undefined,
      startParameter: undefined,

      name:            'Sonoff',
      manufacturer:    'ITEAD',
      model:           'sonoff',
      serialNumberMAC: '',
      switchType:      'switch',
    };

    // Load configuration
    const config = Object.assign({}, defualtConfig, loadedConfig);
    this.config = config;

    // Setup the homebridge service
    this.service = config.switchType !== 'outlet'
      ? new Service.Switch(this.name)
      : new Service.Outlet(this.name)
        .getCharacteristic(Characteristic.OutletInUse)
        .on('get', this.getOutletUse.bind(this));

    this.service
      .getCharacteristic(Characteristic.On)
      .on('get', this.getStatus.bind(this))
      .on('set', this.setStatus.bind(this));

    if (config.activityTopic !== undefined) {
      this.service.addOptionalCharacteristic(Characteristic.StatusActive);
      this.service
        .getCharacteristic(Characteristic.StatusActive)
        .on('get', this.getStatusActive.bind(this));
    }

    this.publishOptions = {qos: config.qos};
    this.powerVal = config.topics.statusSet.split('/').pop();

    // Device state
    this.switchStatus = false;
    this.activeStatus = false;

    // Setup MQTT client configuration
    const randId = Math.random().toString(16).substr(2, 8);
    const mqttClientId = `homebridgeMqtt_${randId}`;

    const mqttOptions = {
      keepalive:          10,
      clientId:           mqttClientId,
      protocolId:         'MQTT',
      protocolVersion:    4,
      reconnectPeriod:    1000,
      connectTimeout:     30 * 1000,
      clean:              true,
      rejectUnauthorized: false,

      username: config.username,
      password: config.password,

      will: {
        topic:   'WillMsg',
        payload: 'Connection Closed abnormally..!',
        retain:  false,
        qos:     0,
      },
    };

    const handlers = {
      [config.topics.statusGet]: this.receiveStatus.bind(this),
      [config.topics.StateGet]:  this.receiveState.bind(this),
      [config.activityTopic]:    this.receiveActivity.bind(this),
    };

    // Listen for the device over mqtt
    this.client = mqtt.connect(config.url, mqttOptions);

    this.client.on('error', _ => log('Error event over mqtt'));

    this.client.on('connect', _ => {
      if (config.startCmd !== undefined && config.startParameter !== undefined) {
        this.client.publish(config.startCmd, config.startParameter);
      }
    });

    this.client.on('message', (topic, message) => {
      if (handlers[topic] === undefined) {
        return;
      }

      try {
        handlers[topic](message);
      } catch (e) {
        log(config.name, `Failed to handle topic: ${message.toString()}`, e);
      }
    });

    // Register for enabled topics
    Object.keys(handlers).map(t => t && this.client.subscribe(t));
  }

  markSwitchStatus(message) {
    const data = JSON.parse(message);

    if (!data.hasOwnProperty(this.powerValue)) {
      return;
    }

    const state = data[this.powerValue];
    this.switchStatus = state == this.config.onValue;
  }

  receiveStatus(message) {
    // XXX: In the event that the user has a DUAL the topicStatusGet will
    // return for POWER1 or POWER2 in the JSON.  We need to coordinate which
    // accessory is actually being reported and only take that POWER data.
    // This assumes that the Sonoff single will return {"POWER": "ON"}
    this.markSwitchStatus(message)
    this.service
      .getCharacteristic(Characteristic.On)
      .setValue(this.switchStatus, undefined, 'fromSetValue');
  }

  receiveState(message) {
    this.markSwitchStatus(message)
    this.service
      .getCharacteristic(Characteristic.On)
      .setValue(this.switchStatus, undefined, null);
  }

  receiveActivity() {
    const state = message.toString();
    this.activeStatus = state == this.config.activityParameter;
    this.service.setCharacteristic(Characteristic.StatusActive, this.activeStatus);
  }

  setStatus(state, next, context) {
    if (context == 'fromSetValue') {
      return next();
    }

    const topic = this.config.topics.statusSet;
    const mqttBoolean = state ? this.config.onValue : this.config.offValue;
    this.switchStatus = state;
    this.client.publish(topic, mqttBoolean, this.publishOptions);
    next();
  }

  getStatus(next) {
    next(null, this.switchStatus);
  }

  getStatusActive(next) {
    next(null, this.activeStatus);
  }

  getOutletUse(next) {
    // XXX: For now outlets are always marked as "in use"
    next(null, true);
  }

  getServices() {
    const serviceInfo = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Name, this.config.name)
      .setCharacteristic(Characteristic.Model, this.config.model)
      .setCharacteristic(Characteristic.Manufacturer, this.config.manufacturer)
      .setCharacteristic(Characteristic.SerialNumber, this.config.serialNumberMAC);

    return [serviceInfo, this.service];
  }
}
