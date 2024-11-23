"use strict";

const Homey = require("homey");
const net = require("net");

module.exports = class SmartPresenceDriver extends Homey.Driver {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [Driver log : `, ...args);
  }

  onInit() {
    this.log("SmartPresence driver has been initialized");
    const devices = this.getDevices();

    devices.forEach((device) => {
      const settings = device.getSettings();

      // Determine the device type based on settings
      let deviceType = "Normal Household Member";
      if (settings.is_guest) {
        deviceType = "Guest";
      } else if (settings.is_kid) {
        deviceType = "Kid";
      }

      this.log(`Device Settings for ${device.getName()}:`, {
        Host: settings.host,
        Port: settings.port,
        "Away Delay": `${settings.away_delay} seconds`,
        "Normal Mode Check Interval": `${settings.normal_mode_interval} ms`,
        "Normal Mode Timeout": `${settings.host_timeout} seconds`,
        "Stress Period": `${settings.start_stressing_at} seconds`,
        "Stress Mode Check Interval": `${settings.stress_mode_interval} ms`,
        "Stress Host Timeout": `${settings.stress_host_timeout} seconds`,
        "Device Type": deviceType,
      });
    });
  }

  async onPair(session) {
    session.setHandler("device_input", async (data) => {
      //this.log('device_input', data);
      if (!data.devicename) {
        throw new Error(this.homey.__("pair.configuration.invalid_device_name"));
      } else if (!data.ip_address) {
        throw new Error(this.homey.__("pair.configuration.missing_ip_address"));
      } else if (!net.isIP(data.ip_address)) {
        throw new Error(this.homey.__("pair.configuration.invalid_ip_address"));
      }
    });
  }
};
