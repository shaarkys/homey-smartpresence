"use strict";

const Homey = require("homey");
const net = require("net");

function formatLastSeenDate(timestamp, homey) {
  // Locale-aware date only (e.g., 17.11.2025 or 11/17/2025)
  const userTimezone = homey.clock.getTimezone();
  const language = homey.i18n?.getLanguage?.();
  const country = homey.i18n?.getCountry?.();
  const locale = [language, country].filter(Boolean).join("-") || "en-US";

  return new Intl.DateTimeFormat(locale, {
    timeZone: userTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function formatLastSeenTime(timestamp, homey) {
  // Locale-aware time only, forced 24h (e.g., 15:45)
  const userTimezone = homey.clock.getTimezone();
  const language = homey.i18n?.getLanguage?.();
  const country = homey.i18n?.getCountry?.();
  const locale = [language, country].filter(Boolean).join("-") || "en-US";

  return new Intl.DateTimeFormat(locale, {
    timeZone: userTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

module.exports = class SmartPresenceDevice extends Homey.Device {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    const deviceName = this.getName();
    console.log(`${timestamp} [Device: ${deviceName} -`, ...args);
  }

  async onInit() {
    this._settings = this.getSettings();
    await this._migrate();
    this._present = this.getCapabilityValue("presence");
    if (this._present === null || typeof this._present === "undefined") {
      this._present = false; // default to offline so first detection always records a full cycle
    }
    this._lastSeen = this.getStoreValue("lastSeen") || 0;

    if (this.hasCapability("lastseen")) {
      await this.removeCapability("lastseen").catch(this.error);
    }
    if (!this.hasCapability("lastseen_date")) {
      await this.addCapability("lastseen_date");
    }
    if (!this.hasCapability("lastseen_time")) {
      await this.addCapability("lastseen_time");
    }
    if (!this.hasCapability("device_type")) {
      await this.addCapability("device_type");
    }
    await this.updateDeviceTypeCapability();

    if (this._lastSeen) {
      await this.setLastSeenCapabilities(this._lastSeen);
    }

    this._isInStressMode = false; // Initialize the stress mode status
    this._isUnreachable = false; // Initialize device responsiveness status

    this.scan();
  }

  async _migrate() {
    try {
      const ver = this.getStoreValue("ver");
      if (ver === null) {
        if (this.getNormalModeInterval() < 3000) {
          await this.setSettings({ normal_mode_interval: 3000 });
        }
        if (this.getStressModeInterval() < 1500) {
          await this.setSettings({ stress_mode_interval: 1500 });
        }
      }
      if (ver < 2) {
        if (this.hasCapability("onoff")) {
          const presence = this.getCapabilityValue("onoff");
          await this.removeCapability("onoff");
          await this.addCapability("presence");
          await this.setCapabilityValue("presence", presence).catch(this.error);
        }
        await this.setStoreValue("ver", 2);
      }
    } catch (err) {
      this.log("Migration failed", err);
    }
  }

  onDeleted() {
    this._deleted = true;
    this.destroyClient();
    this.clearScanTimer();
    this.log(`Device ${this.getName()} Deleted.`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this._settings = newSettings;
    if (changedKeys.includes("is_guest") || changedKeys.includes("is_kid")) {
      await this.updateDeviceTypeCapability();
    }
  }

  getHost() {
    return this._settings.host;
  }

  getPort() {
    const port = this._settings.port;
    if (port === null || typeof port === "undefined") {
      const numbers = ["32001", "32000"];
      return numbers[Math.floor(Math.random() * numbers.length)];
    }
    return port;
  }

  getNormalModeInterval() {
    return this._settings.normal_mode_interval;
  }

  getNormalModeTimeout() {
    return this._settings.host_timeout * 1000;
  }

  getAwayDelayInMillis() {
    return this._settings.away_delay * 1000;
  }

  getStressModeInterval() {
    return this._settings.stress_mode_interval;
  }

  getStressModeTimeout() {
    return this._settings.stress_host_timeout * 1000;
  }

  getStressAtInMillis() {
    return this._settings.start_stressing_at * 1000;
  }

  isHouseHoldMember() {
    return !this.isGuest();
  }

  isKid() {
    return this._settings.is_kid;
  }

  isGuest() {
    return this._settings.is_guest;
  }

  getLastSeen() {
    return this._lastSeen;
  }

  async setLastSeenCapabilities(timestamp) {
    const lastSeenDate = formatLastSeenDate(timestamp, this.homey);
    const lastSeenTime = formatLastSeenTime(timestamp, this.homey);
    await this.setCapabilityValue("lastseen_date", lastSeenDate).catch(this.error);
    await this.setCapabilityValue("lastseen_time", lastSeenTime).catch(this.error);
  }

  async updateLastSeen() {
    const now = Date.now();

    // Update the last seen time in store if more than 60 seconds have passed since the last update
    if (!this._lastSeen || now - this._lastSeen > 60000) {
      try {
        await this.setLastSeenCapabilities(now);
        this._lastSeen = now;
        // Store the raw timestamp in the store
        await this.setStoreValue("lastSeen", now);
      } catch (err) {
        this.log("Error updating last seen:", err.message);
      }
    }
  }

  getSeenMillisAgo() {
    return Date.now() - this.getLastSeen();
  }

  shouldDelayAwayStateSwitch() {
    return this.getSeenMillisAgo() < this.getAwayDelayInMillis();
  }

  shouldStressCheck() {
    const timeSinceLastSeen = this.getSeenMillisAgo();
    const awayDelay = this.getAwayDelayInMillis();
    const stressAt = this.getStressAtInMillis();

    // previous method, triggered each time even when device was not in stress test period
    //return !!this.getPresenceStatus() && this.getAwayDelayInMillis() - this.getSeenMillisAgo() < this.getStressAtInMillis();
    return this._isUnreachable && timeSinceLastSeen >= awayDelay - stressAt && timeSinceLastSeen < awayDelay;
  }

  clearScanTimer() {
    if (this.scanTimer) {
      this.homey.clearTimeout(this.scanTimer);
      this.scanTimer = undefined;
    }
  }

  scheduleScans(interval) {
    if (this._deleted) {
      return;
    }
    this.clearScanTimer();
    this.scanTimer = this.homey.setTimeout(this.scan.bind(this), interval);
  }

  async scan() {
    const host = this.getHost();
    const port = this.getPort();
    const stressTest = this.shouldStressCheck();
    const interval = stressTest ? this.getStressModeInterval() : this.getNormalModeInterval();
    const timeout = stressTest ? this.getStressModeTimeout() : this.getNormalModeTimeout();
    const timeSinceLastSeen = Math.floor(this.getSeenMillisAgo() / 1000); // Time since last seen in seconds
    const deviceName = this.getName();

    // Add logging for stress period transitions
    if (stressTest !== this._isInStressMode) {
      this._isInStressMode = stressTest;
      if (stressTest) {
        this.log(`Time since last seen: ${timeSinceLastSeen}s - Stress period started for ${deviceName}`);
      } else {
        this.log(`Stress period ended for ${deviceName}`);
      }
    }

    try {
      //this.log(`${host}:${port}: scanning, timeout: ${timeout}, interval: ${interval}`);
      this.scanDevice(host, port, timeout);
    } finally {
      this.scheduleScans(interval);
    }
  }

  destroyClient() {
    if (this.client) {
      this.client.destroy();
      this.client = undefined;
    }
    if (this.cancelCheck) {
      this.homey.clearTimeout(this.cancelCheck);
      this.cancelCheck = undefined;
    }
  }

  scanDevice(host, port, timeout) {
    this.destroyClient();
    this.client = new net.Socket();

    this.cancelCheck = this.homey.setTimeout(() => {
      this.destroyClient();

      // Log timeout only if the device was previously online
      if (this._present) {
        this.log(`${host}:${port} Timeout after ${Math.floor(timeout / 1000)}s -> Offline`);
      }

      this._isUnreachable = true; // Device is unresponsive due to timeout
      this.setPresent(false);
    }, timeout);

    this.client.on("error", (err) => {
      this.destroyClient();
      if (err && (err.errno === "ECONNREFUSED" || err.code === "ECONNREFUSED")) {
        // Connection refused indicates the device is online
        if (!this._present) {
          this.log(`${host}:${port} Connection refused -> Online`);
        }
        this._isUnreachable = false; // Device is responsive
        this.setPresent(true);
      } else {
        // Log error only if the device was previously online
        if (this._present) {
          this.log(`${host}:${port} Error -> Offline`);
        }
        this._isUnreachable = true; // Device is unresponsive due to error
        this.setPresent(false);
      }
    });

    try {
      this.client.connect(port, host, () => {
        this.destroyClient();

        // Log connection only if the device was previously offline
        if (!this._present) {
          this.log(`${host}:${port}: Connected -> Online`);
        }

        this._isUnreachable = false; // Device is responsive
        this.setPresent(true);
      });
    } catch (err) {
      this.destroyClient();

      // Log connection error only if the device was previously online
      if (this._present) {
        this.log(`${host}:${port} Connection error -> Offline`);
      }

      this._isUnreachable = true; // Device is unresponsive due to exception
      this.setPresent(false);
    }
  }

  async setPresent(present) {
    const currentPresent = this.getPresenceStatus();
    const tokens = this.getFlowCardTokens();

    if (present && !currentPresent) {
      await this.updateLastSeen(); // Update last seen only when transitioning to present
      this.log(`${this.getHost()} - ${this.getName()}: is online`);
      await this.setPresenceStatus(present);
      await this.homey.app.deviceArrived(this);
      await this.homey.app.userEnteredTrigger.trigger(this, tokens, {}).catch(this.error);
      await this.homey.app.someoneEnteredTrigger.trigger(tokens, {}).catch(this.error);
      if (this.isHouseHoldMember()) {
        await this.homey.app.householdMemberArrivedTrigger.trigger(tokens, {}).catch(this.error);
      }
      if (this.isKid()) {
        await this.homey.app.kidArrivedTrigger.trigger(tokens, {}).catch(this.error);
      }
      if (this.isGuest()) {
        await this.homey.app.guestArrivedTrigger.trigger(tokens, {}).catch(this.error);
      }
    } else if (!present && currentPresent !== false) {
      if (!this.shouldDelayAwayStateSwitch()) {
        this.log(`${this.getHost()} : is marked as offline`);

        // Update stress mode status
        if (this._isInStressMode) {
          const timeSinceLastSeen = Math.floor(this.getSeenMillisAgo() / 1000);
          this._isInStressMode = false;
          this.log(`Time since last seen: ${timeSinceLastSeen}s - Stress period ended`);
        }

        await this.setPresenceStatus(present);
        this.log(`Device is finally marked as unavailable`);
        await this.homey.app.deviceLeft(this, tokens);
        await this.homey.app.userLeftTrigger.trigger(this, tokens, {}).catch(this.error);
        await this.homey.app.someoneLeftTrigger.trigger(tokens, {}).catch(this.error);
        if (this.isHouseHoldMember()) {
          await this.homey.app.householdMemberLeftTrigger.trigger(tokens, {}).catch(this.error);
        }
        if (this.isKid()) {
          await this.homey.app.kidLeftTrigger.trigger(tokens, {}).catch(this.error);
        }
        if (this.isGuest()) {
          await this.homey.app.guestLeftTrigger.trigger(tokens, {}).catch(this.error);
        }
      }
    }
  }

  getFlowCardTokens() {
    return { who: this.getName() };
  }

  getPresenceStatus() {
    return this._present;
  }

  getDeviceTypeValue() {
    if (this.isGuest() && this.isKid()) return "Guest (Kid)";
    if (this.isGuest()) return "Guest";
    if (this.isKid()) return "Kid";
    return "Member";
  }

  async updateDeviceTypeCapability() {
    const value = this.getDeviceTypeValue();
    await this.setCapabilityValue("device_type", value).catch(this.error);
  }

  async setPresenceStatus(present) {
    this._present = present;
    await this.setCapabilityValue("presence", present).catch(this.error);
  }

  async userAtHome() {
    return !!this.getCapabilityValue("presence");
  }
};
