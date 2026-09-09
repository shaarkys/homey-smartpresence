"use strict";

const Homey = require("homey");
const net = require("net");
const { isValidHost, normalizeHost } = require("../../lib/host");

const DEFAULT_OVERRIDE_DURATION_MINUTES = 5;
const MAX_TIMER_DELAY = 2147483647;
const OVERRIDE_STORE_KEY = "presenceOverride";
const DETECTED_PRESENCE_STORE_KEY = "detectedPresent";

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
    this._presenceOverrideQueue = Promise.resolve();
    this._detectionSequence = 0;
    this._detectedPresencePersistence = undefined;
    this._detectedPresencePersistenceDirty = false;
    this._effectivePresenceGeneration = 0;
    this._effectivePresenceTarget = undefined;
    await this._migrate();
    this._present = this.getCapabilityValue("presence");
    if (this._present === null || typeof this._present === "undefined") {
      this._present = false; // default to offline so first detection always records a full cycle
      await this.setCapabilityValue("presence", false);
    }
    const storedDetectedPresent = this.getStoreValue(DETECTED_PRESENCE_STORE_KEY);
    this._detectedPresent = typeof storedDetectedPresent === "boolean" ? storedDetectedPresent : this._present;
    this._presenceOverride = null;
    this._overrideExpiresAt = null;
    await this.loadPresenceOverride();
    this._lastSeen = this.getStoreValue("lastSeen") || 0;
    this._lastSeenPersisted = this._lastSeen;
    this._lastSeenPersistence = undefined;

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
    await this.updatePresenceOverrideCapabilities();
    this.schedulePresenceOverrideTimer();

    this.registerCapabilityListener("presence", async (present, options = {}) => {
      await this.setPresenceOverride(!!present, options.duration);
    });
    this.registerCapabilityListener("presence_mode", async (mode) => {
      if (mode === "automatic") {
        await this.clearPresenceOverride();
        return;
      }
      if (mode !== "present" && mode !== "away") {
        throw new Error(`Unsupported presence mode: ${mode}`);
      }
      await this.setPresenceOverride(mode === "present");
    });

    if (this._lastSeen) {
      await this.setLastSeenCapabilities(this._lastSeen);
    }

    this._isInStressMode = false; // Initialize the stress mode status
    this._isUnreachable = false; // Initialize device responsiveness status
    this.resetOfflineProbeStats();
    await this.reconcilePresence();

    if (this.shouldScanNetwork()) {
      this.scan();
    }
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
      if (!this.hasCapability("presence")) {
        await this.addCapability("presence");
        await this.setCapabilityValue("presence", false).catch(this.error);
      }
      if (!this.hasCapability("presence_mode")) {
        await this.addCapability("presence_mode");
      }
      if (!this.hasCapability("measure_presence_override_remaining")) {
        await this.addCapability("measure_presence_override_remaining");
      }
    } catch (err) {
      this.log("Migration failed", err);
    }
  }

  onDeleted() {
    this._deleted = true;
    this.destroyClient();
    this.clearScanTimer();
    this.clearPresenceOverrideTimer();
    this.log(`Device ${this.getName()} Deleted.`);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const host = normalizeHost(newSettings.host);
    const manualOnly = !!newSettings.manual_only;
    if (!manualOnly && !host) {
      throw new Error(this.homey.__("pair.configuration.missing_ip_address"));
    }
    if (host && !isValidHost(host)) {
      throw new Error(this.homey.__("pair.configuration.invalid_ip_address"));
    }
    this._settings = { ...newSettings, host };
    if (changedKeys.includes("is_guest") || changedKeys.includes("is_kid")) {
      await this.updateDeviceTypeCapability();
    }
    if (changedKeys.includes("host") || changedKeys.includes("port") || changedKeys.includes("manual_only")) {
      this.destroyClient();
      this.clearScanTimer();
      if (this.shouldScanNetwork()) {
        this.scan();
      } else {
        await this.setDetectedPresent(false, { immediate: true });
      }
    }
  }

  getHost() {
    return normalizeHost(this._settings.host);
  }

  isManualOnly() {
    return !!this._settings.manual_only;
  }

  shouldScanNetwork() {
    return !this.isManualOnly() && !!this.getHost();
  }

  getDefaultOverrideDurationInMillis() {
    const configuredMinutes = Number(this._settings.default_override_duration);
    const minutes = Number.isFinite(configuredMinutes) && configuredMinutes >= 0
      ? configuredMinutes
      : DEFAULT_OVERRIDE_DURATION_MINUTES;
    return minutes === 0 ? null : minutes * 60000;
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

  async loadPresenceOverride() {
    const storedOverride = this.getStoreValue(OVERRIDE_STORE_KEY);
    if (!storedOverride || typeof storedOverride.value !== "boolean") {
      return;
    }

    const expiresAt = Number(storedOverride.expiresAt);
    const hasExpiration = Number.isFinite(expiresAt) && expiresAt > 0;
    if (hasExpiration && expiresAt <= Date.now()) {
      await this.unsetStoreValue(OVERRIDE_STORE_KEY);
      return;
    }

    this._presenceOverride = storedOverride.value;
    this._overrideExpiresAt = hasExpiration ? expiresAt : null;
  }

  enqueuePresenceOverrideUpdate(operation) {
    const queuedOperation = this._presenceOverrideQueue
      .catch((err) => this.log("Previous presence override update failed", err))
      .then(operation);
    this._presenceOverrideQueue = queuedOperation;
    return queuedOperation;
  }

  getRequestedOverrideDuration(duration) {
    const requestedDuration = Number(duration);
    if (Number.isFinite(requestedDuration) && requestedDuration > 0) {
      return requestedDuration;
    }
    return this.getDefaultOverrideDurationInMillis();
  }

  async setPresenceOverride(present, duration) {
    return this.enqueuePresenceOverrideUpdate(async () => {
      const overrideDuration = this.getRequestedOverrideDuration(duration);
      this._presenceOverride = !!present;
      this._overrideExpiresAt = overrideDuration === null ? null : Date.now() + overrideDuration;
      await this.setStoreValue(OVERRIDE_STORE_KEY, {
        value: this._presenceOverride,
        expiresAt: this._overrideExpiresAt,
      });
      await this.updatePresenceOverrideCapabilities();
      this.schedulePresenceOverrideTimer();
      await this.reconcilePresence();
      this.log(
        `Presence override set to ${this._presenceOverride ? "present" : "away"}`
        + (this._overrideExpiresAt ? ` until ${new Date(this._overrideExpiresAt).toISOString()}` : " until cleared"),
      );
    });
  }

  async clearPresenceOverride() {
    return this.enqueuePresenceOverrideUpdate(async () => {
      if (this._presenceOverride === null) {
        return;
      }
      this._presenceOverride = null;
      this._overrideExpiresAt = null;
      this.clearPresenceOverrideTimer();
      await this.unsetStoreValue(OVERRIDE_STORE_KEY);
      await this.updatePresenceOverrideCapabilities();
      await this.reconcilePresence();
      this.log("Presence override cleared; automatic detection resumed");
    });
  }

  getPresenceOverrideMode() {
    if (this._presenceOverride === true) return "present";
    if (this._presenceOverride === false) return "away";
    return "automatic";
  }

  getPresenceOverrideRemainingMinutes() {
    if (this._presenceOverride === null || this._overrideExpiresAt === null) {
      return null;
    }
    return Math.max(1, Math.ceil((this._overrideExpiresAt - Date.now()) / 60000));
  }

  async updatePresenceOverrideCapabilities() {
    const mode = this.getPresenceOverrideMode();
    const remainingMinutes = this.getPresenceOverrideRemainingMinutes();
    if (this.getCapabilityValue("presence_mode") !== mode) {
      await this.setCapabilityValue("presence_mode", mode);
    }
    if (this.getCapabilityValue("measure_presence_override_remaining") !== remainingMinutes) {
      await this.setCapabilityValue("measure_presence_override_remaining", remainingMinutes);
    }
  }

  clearPresenceOverrideTimer() {
    if (this.presenceOverrideTimer) {
      this.homey.clearTimeout(this.presenceOverrideTimer);
      this.presenceOverrideTimer = undefined;
    }
  }

  schedulePresenceOverrideTimer() {
    this.clearPresenceOverrideTimer();
    if (this._presenceOverride === null || this._overrideExpiresAt === null || this._deleted) {
      return;
    }

    const expectedExpiresAt = this._overrideExpiresAt;
    const remaining = expectedExpiresAt - Date.now();
    if (remaining <= 0) {
      this.presenceOverrideTimer = this.homey.setTimeout(() => {
        this.clearPresenceOverride().catch((err) => this.log("Failed to expire presence override", err));
      }, 0);
      return;
    }

    const displayedMinutes = Math.ceil(remaining / 60000);
    const nextDisplayChange = remaining - ((displayedMinutes - 1) * 60000);
    const nextDelay = displayedMinutes === 1 ? remaining : nextDisplayChange + 100;
    const delay = Math.min(Math.max(nextDelay, 1), MAX_TIMER_DELAY);
    this.presenceOverrideTimer = this.homey.setTimeout(() => {
      this.presenceOverrideTimer = undefined;
      if (this._overrideExpiresAt !== expectedExpiresAt) {
        return;
      }
      if (Date.now() >= expectedExpiresAt) {
        this.clearPresenceOverride().catch((err) => this.log("Failed to expire presence override", err));
        return;
      }
      this.updatePresenceOverrideCapabilities()
        .then(() => this.schedulePresenceOverrideTimer())
        .catch((err) => this.log("Failed to update presence override countdown", err));
    }, delay);
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

    const isRecovery = reason === "device detected again";
    if (isRecovery && total < 2) {
      this.resetOfflineProbeStats();
      return;
    }

    const durationEnd = isRecovery ? Date.now() : lastAt;
    const durationSeconds = Math.max(0, Math.round((durationEnd - startedAt) / 1000));
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

  updateLastSeen() {
    const now = Date.now();

    // Always refresh in-memory timestamp so short drops do not accumulate "time since last seen"
    this._lastSeen = now;

    // Persist to capabilities/store at most once per minute to avoid noisy writes
    if (this._lastSeenPersistence) {
      return this._lastSeenPersistence;
    }
    if (!this._lastSeenPersisted || now - this._lastSeenPersisted > 60000) {
      const persistence = (async () => {
        try {
          await this.setLastSeenCapabilities(now);
          await this.setStoreValue("lastSeen", now);
          this._lastSeenPersisted = now;
        } catch (err) {
          this.log("Error updating last seen:", err.message);
        }
      })();
      this._lastSeenPersistence = persistence;
      persistence.then(() => {
        if (this._lastSeenPersistence === persistence) {
          this._lastSeenPersistence = undefined;
        }
      });
      return persistence;
    }
    return Promise.resolve();
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
    if (!this.shouldScanNetwork()) {
      this.destroyClient();
      this.clearScanTimer();
      return;
    }
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

  destroyClient(client = this.client, cancelCheck = this.cancelCheck) {
    const isCurrentClient = !client || this.client === client;
    const isCurrentCancelCheck = !cancelCheck || this.cancelCheck === cancelCheck;

    if (client) {
      client.destroy();
    }
    if (isCurrentClient) {
      this.client = undefined;
    }
    if (cancelCheck) {
      this.homey.clearTimeout(cancelCheck);
    }
    if (isCurrentCancelCheck) {
      this.cancelCheck = undefined;
    }
  }

  scanDevice(host, port, timeout) {
    this.destroyClient();
    const client = new net.Socket();
    this.client = client;

    const cancelCheck = this.homey.setTimeout(() => {
      if (this.client !== client) {
        return;
      }

      this.destroyClient(client, cancelCheck);

      if (this._detectedPresent) {
        this.trackOfflineProbe("timeout", host, port);
      }

      this._isUnreachable = true; // Device is unresponsive due to timeout
      this.setDetectedPresent(false).catch((err) => this.log("Failed to update presence after timeout", err));
    }, timeout);
    this.cancelCheck = cancelCheck;

    client.on("error", (err) => {
      if (this.client !== client) {
        return;
      }

      this.destroyClient(client, cancelCheck);
      if (err && (err.errno === "ECONNREFUSED" || err.code === "ECONNREFUSED")) {
        // Connection refused indicates the device is online
        this.flushOfflineProbeStats("device detected again");
        if (!this._detectedPresent) {
          this.log(`${host}:${port} Connection refused -> Online`);
        }
        this._isUnreachable = false; // Device is responsive
        this.setDetectedPresent(true).catch((err) => this.log("Failed to update presence after connection refused", err));
      } else {
        if (this._detectedPresent) {
          this.trackOfflineProbe("error", host, port);
        }
        this._isUnreachable = true; // Device is unresponsive due to error
        this.setDetectedPresent(false).catch((err) => this.log("Failed to update presence after socket error", err));
      }
    });

    try {
      client.connect(port, host, () => {
        if (this.client !== client) {
          client.destroy();
          return;
        }

        this.destroyClient(client, cancelCheck);

        this.flushOfflineProbeStats("device detected again");

        // Log connection only if the device was previously offline
        if (!this._detectedPresent) {
          this.log(`${host}:${port}: Connected -> Online`);
        }

        this._isUnreachable = false; // Device is responsive
        this.setDetectedPresent(true).catch((err) => this.log("Failed to update presence after connect", err));
      });
    } catch (err) {
      if (this.client !== client) {
        return;
      }

      this.destroyClient(client, cancelCheck);

      if (this._detectedPresent) {
        this.trackOfflineProbe("exception", host, port);
      }

      this._isUnreachable = true; // Device is unresponsive due to exception
      this.setDetectedPresent(false).catch((setPresentErr) => this.log("Failed to update presence after connection error", setPresentErr));
    }
  }

  persistDetectedPresence() {
    this._detectedPresencePersistenceDirty = true;
    if (this._detectedPresencePersistence) {
      return this._detectedPresencePersistence;
    }

    let persistence;
    persistence = (async () => {
      while (this._detectedPresencePersistenceDirty) {
        this._detectedPresencePersistenceDirty = false;
        const present = this._detectedPresent;
        try {
          await this.setStoreValue(DETECTED_PRESENCE_STORE_KEY, present);
        } catch (err) {
          this.log("Failed to persist detected presence", err);
          return;
        }
      }
    })().finally(() => {
      if (this._detectedPresencePersistence === persistence) {
        this._detectedPresencePersistence = undefined;
        if (this._detectedPresencePersistenceDirty) {
          void this.persistDetectedPresence();
        }
      }
    });
    this._detectedPresencePersistence = persistence;
    return persistence;
  }

  async setDetectedPresent(present, { immediate = false } = {}) {
    const detectionSequence = ++this._detectionSequence;
    if (present) {
      this.flushOfflineProbeStats("device detected again");

      // Persist last-seen in the background so a pending Homey write cannot block detection.
      void this.updateLastSeen();
      if (detectionSequence !== this._detectionSequence) {
        return;
      }
      if (!this._detectedPresent) {
        this._detectedPresent = true;
        void this.persistDetectedPresence();
        await this.reconcilePresence();
      }
      return;
    }

    if (!this._detectedPresent || (!immediate && this.shouldDelayAwayStateSwitch())) {
      return;
    }

    this.flushOfflineProbeStats("device finally marked offline");
    this.log(`${this.getHost() || this.getName()} : is marked as offline by network detection`);

    if (this._isInStressMode) {
      const timeSinceLastSeen = Math.floor(this.getSeenMillisAgo() / 1000);
      this._isInStressMode = false;
      this.log(`Time since last seen: ${timeSinceLastSeen}s - Stress period ended`);
    }

    this._detectedPresent = false;
    void this.persistDetectedPresence();
    if (detectionSequence === this._detectionSequence) {
      await this.reconcilePresence();
    }
  }

  getEffectivePresence() {
    return this._presenceOverride === null
      ? this._detectedPresent
      : this._presenceOverride;
  }

  async reconcilePresence() {
    const effectivePresent = this.getEffectivePresence();
    if (this._effectivePresenceTarget !== effectivePresent) {
      this._effectivePresenceTarget = effectivePresent;
      this._effectivePresenceGeneration += 1;
    }
    await this.applyEffectivePresence(effectivePresent, this._effectivePresenceGeneration);
  }

  isEffectiveTransitionCurrent(present, transitionGeneration) {
    return this._effectivePresenceGeneration === transitionGeneration
      && this._effectivePresenceTarget === present
      && this.getEffectivePresence() === present;
  }

  async applyEffectivePresence(present, transitionGeneration) {
    const isCurrent = () => this.isEffectiveTransitionCurrent(present, transitionGeneration);
    if (!isCurrent()) {
      return;
    }
    const currentPresent = this.getPresenceStatus();
    if (currentPresent === present) {
      return;
    }
    const tokens = this.getFlowCardTokens();

    // Capture peers before setPresenceStatus changes _present synchronously. Waiting
    // for its capability write first can duplicate last-person or miss first-person Flows.
    const presenceBeforeTransition = this.homey.app.getPresenceStatus();

    if (present) {
      this.log(`${this.getName()}: is present`);
      await this.setPresenceStatus(true);
      if (!isCurrent()) {
        this.log("Skipped stale present flow trigger");
        return;
      }
      await this.homey.app.deviceArrived(this, isCurrent, presenceBeforeTransition);
      if (!isCurrent()) return;
      await this.homey.app.userEnteredTrigger.trigger(this, tokens, {}).catch((err) => this.error(err));
      if (!isCurrent()) return;
      await this.homey.app.someoneEnteredTrigger.trigger(tokens, {}).catch((err) => this.error(err));
      if (!isCurrent()) return;
      if (this.isHouseHoldMember()) {
        await this.homey.app.householdMemberArrivedTrigger.trigger(tokens, {}).catch((err) => this.error(err));
        if (!isCurrent()) return;
      }
      if (this.isKid()) {
        await this.homey.app.kidArrivedTrigger.trigger(tokens, {}).catch((err) => this.error(err));
        if (!isCurrent()) return;
      }
      if (this.isGuest()) {
        await this.homey.app.guestArrivedTrigger.trigger(tokens, {}).catch((err) => this.error(err));
      }
      return;
    }

    this.log(`${this.getName()}: is away`);
    await this.setPresenceStatus(false);
    if (!isCurrent()) {
      this.log("Skipped stale offline flow trigger");
      return;
    }
    this.log("Device is finally marked as unavailable");
    await this.homey.app.deviceLeft(this, tokens, isCurrent, presenceBeforeTransition);
    if (!isCurrent()) return;
    await this.homey.app.userLeftTrigger.trigger(this, tokens, {}).catch((err) => this.error(err));
    if (!isCurrent()) return;
    await this.homey.app.someoneLeftTrigger.trigger(tokens, {}).catch((err) => this.error(err));
    if (!isCurrent()) return;
    if (this.isHouseHoldMember()) {
      await this.homey.app.householdMemberLeftTrigger.trigger(tokens, {}).catch((err) => this.error(err));
      if (!isCurrent()) return;
    }
    if (this.isKid()) {
      await this.homey.app.kidLeftTrigger.trigger(tokens, {}).catch((err) => this.error(err));
      if (!isCurrent()) return;
    }
    if (this.isGuest()) {
      await this.homey.app.guestLeftTrigger.trigger(tokens, {}).catch((err) => this.error(err));
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
