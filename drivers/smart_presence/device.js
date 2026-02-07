"use strict";

const Homey = require("homey");
const net = require("net");

function formatLastSeenDate(timestamp, homey) {
  // Locale-aware date only (US uses month-first, others day-first)
  const userTimezone = homey.clock.getTimezone();
  const language = homey.i18n?.getLanguage?.();
  const country = homey.i18n?.getCountry?.();
  const locale = [language, country].filter(Boolean).join("-") || "en-GB";
  const isUsFormat = typeof country === "string" && country.toUpperCase() === "US";

  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: userTimezone,
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const values = {};
  for (const part of parts) {
    if (part.type === "day" || part.type === "month" || part.type === "year") {
      values[part.type] = part.value;
    }
  }
  if (!values.day || !values.month || !values.year) {
    return formatter.format(new Date(timestamp));
  }
  return isUsFormat
    ? `${values.month}/${values.day}/${values.year}`
    : `${values.day}/${values.month}/${values.year}`;
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

function formatLastSeenDateTime(timestamp, homey) {
  const lastSeenDate = formatLastSeenDate(timestamp, homey);
  const lastSeenTime = formatLastSeenTime(timestamp, homey);
  return `${lastSeenDate} ${lastSeenTime}`;
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
    this._lastSeenPersisted = this._lastSeen;

    try {
      if (this.hasCapability("lastseen")) {
        await this.removeCapability("lastseen");
      }
      if (!this.hasCapability("lastseen_date")) {
        await this.addCapability("lastseen_date");
      }
      if (!this.hasCapability("lastseen_time")) {
        await this.addCapability("lastseen_time");
      }
      if (!this.hasCapability("lastseen_datetime")) {
        await this.addCapability("lastseen_datetime");
      }
      if (!this.hasCapability("device_type")) {
        await this.addCapability("device_type");
      }
    } catch (err) {
      this.log("Capability update failed during init", err);
    }
    await this.updateDeviceTypeCapability();

    if (this._lastSeen) {
      await this.setLastSeenCapabilities(this._lastSeen);
    }

    this._isInStressMode = false; // Initialize the stress mode status
    this._isUnreachable = false; // Initialize device responsiveness status
    this.resetOfflineProbeStats();

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

  resetOfflineProbeStats() {
    this._offlineProbeStats = {
      host: undefined,
      port: undefined,
      startedAt: 0,
      lastAt: 0,
      timeouts: 0,
      errors: 0,
      exceptions: 0,
    };
  }

  trackOfflineProbe(type, host, port) {
    const now = Date.now();
    if (!this._offlineProbeStats.startedAt) {
      this._offlineProbeStats.startedAt = now;
      this._offlineProbeStats.host = host;
      this._offlineProbeStats.port = port;
    }
    this._offlineProbeStats.lastAt = now;
    if (type === "timeout") {
      this._offlineProbeStats.timeouts += 1;
    } else if (type === "error") {
      this._offlineProbeStats.errors += 1;
    } else if (type === "exception") {
      this._offlineProbeStats.exceptions += 1;
    }
  }

  flushOfflineProbeStats(reason) {
    const { host, port, startedAt, lastAt, timeouts, errors, exceptions } = this._offlineProbeStats;
    const total = timeouts + errors + exceptions;
    if (!total) {
      return;
    }

    const durationSeconds = Math.max(0, Math.round((lastAt - startedAt) / 1000));
    this.log(
      `${host}:${port} Offline probe summary (${reason}): total=${total}, timeouts=${timeouts}, errors=${errors}, exceptions=${exceptions}, duration=${durationSeconds}s`,
    );
    this.resetOfflineProbeStats();
  }

  async setLastSeenCapabilities(timestamp) {
    const lastSeenDate = formatLastSeenDate(timestamp, this.homey);
    const lastSeenTime = formatLastSeenTime(timestamp, this.homey);
    const lastSeenDateTime = formatLastSeenDateTime(timestamp, this.homey);
    await this.setCapabilityValue("lastseen_date", lastSeenDate).catch(this.error);
    await this.setCapabilityValue("lastseen_time", lastSeenTime).catch(this.error);
    await this.setCapabilityValue("lastseen_datetime", lastSeenDateTime).catch(this.error);
  }

  async updateLastSeen() {
    const now = Date.now();

    // Always refresh in-memory timestamp so short drops do not accumulate "time since last seen"
    this._lastSeen = now;

    // Persist to capabilities/store at most once per minute to avoid noisy writes
    if (!this._lastSeenPersisted || now - this._lastSeenPersisted > 60000) {
      try {
        await this.setLastSeenCapabilities(now);
        await this.setStoreValue("lastSeen", now);
        this._lastSeenPersisted = now;
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
    if (!this._isUnreachable || stressAt <= 0 || stressAt >= awayDelay) {
      return false;
    }
    return timeSinceLastSeen >= awayDelay - stressAt && timeSinceLastSeen < awayDelay;
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

      if (this._present) {
        this.trackOfflineProbe("timeout", host, port);
      }

      this._isUnreachable = true; // Device is unresponsive due to timeout
      this.setPresent(false).catch((err) => this.log("Failed to update presence after timeout", err));
    }, timeout);

    this.client.on("error", (err) => {
      this.destroyClient();
      if (err && (err.errno === "ECONNREFUSED" || err.code === "ECONNREFUSED")) {
        // Connection refused indicates the device is online
        this.flushOfflineProbeStats("device detected again");
        if (!this._present) {
          this.log(`${host}:${port} Connection refused -> Online`);
        }
        this._isUnreachable = false; // Device is responsive
        this.setPresent(true).catch((err) => this.log("Failed to update presence after connection refused", err));
      } else {
        if (this._present) {
          this.trackOfflineProbe("error", host, port);
        }
        this._isUnreachable = true; // Device is unresponsive due to error
        this.setPresent(false).catch((err) => this.log("Failed to update presence after socket error", err));
      }
    });

    try {
      this.client.connect(port, host, () => {
        this.destroyClient();

        this.flushOfflineProbeStats("device detected again");

        // Log connection only if the device was previously offline
        if (!this._present) {
          this.log(`${host}:${port}: Connected -> Online`);
        }

        this._isUnreachable = false; // Device is responsive
        this.setPresent(true).catch((err) => this.log("Failed to update presence after connect", err));
      });
    } catch (err) {
      this.destroyClient();

      if (this._present) {
        this.trackOfflineProbe("exception", host, port);
      }

      this._isUnreachable = true; // Device is unresponsive due to exception
      this.setPresent(false).catch((setPresentErr) => this.log("Failed to update presence after connection error", setPresentErr));
    }
  }

  async setPresent(present) {
    const currentPresent = this.getPresenceStatus();
    const tokens = this.getFlowCardTokens();

    if (present) {
      this.flushOfflineProbeStats("device detected again");

      // Refresh last-seen even when already marked present so short drops don't trip away delay
      await this.updateLastSeen();

      if (!currentPresent) {
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
      }
    } else if (!present && currentPresent !== false) {
      if (!this.shouldDelayAwayStateSwitch()) {
        this.flushOfflineProbeStats("device finally marked offline");
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
