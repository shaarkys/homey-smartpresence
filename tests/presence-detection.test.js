"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const { after, test } = require("node:test");

const originalLoad = Module._load;
Module._load = function loadWithHomeyMock(request, parent, isMain) {
  if (request === "homey") {
    return {
      App: class App {},
      Device: class Device {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const SmartPresenceDevice = require("../drivers/smart_presence/device");
const SmartPresenceApp = require("../app");

after(() => {
  Module._load = originalLoad;
});

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settlesWithin(promise, timeout = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Operation remained blocked")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createDevice(overrides = {}) {
  const device = Object.create(SmartPresenceDevice.prototype);
  Object.assign(device, {
    _detectedPresent: false,
    _detectedPresencePersistence: undefined,
    _detectedPresencePersistenceDirty: false,
    _detectionSequence: 0,
    _effectivePresenceGeneration: 0,
    _effectivePresenceTarget: undefined,
    _isInStressMode: false,
    _present: false,
    _presenceOverride: null,
    flushOfflineProbeStats() {},
    getHost() {
      return "192.0.2.1";
    },
    getName() {
      return "Test phone";
    },
    log() {},
    reconcilePresence: async function reconcilePresence() {
      this._present = this._detectedPresent;
    },
    setStoreValue: async () => {},
    shouldDelayAwayStateSwitch: () => false,
    updateLastSeen: async () => {},
  }, overrides);
  return device;
}

function createHousehold(members) {
  const calls = [];
  const app = Object.create(SmartPresenceApp.prototype);
  app.log = () => {};
  app.error = (err) => { throw err; };
  const devices = [];
  const homey = {
    app,
    clock: { getTimezone: () => "UTC" },
    i18n: { getLanguage: () => "en", getCountry: () => "GB" },
    drivers: { getDriver: () => ({ getDevices: () => devices }) },
  };
  app.homey = homey;
  for (const name of [
    "firstPersonEntered", "firstHouseholdMemberArrived", "firstKidArrived", "firstGuestArrived",
    "lastPersonLeft", "lastHouseholdMemberLeft", "lastKidLeft", "lastGuestLeft",
    "userEntered", "someoneEntered", "householdMemberArrived", "kidArrived", "guestArrived",
    "userLeft", "someoneLeft", "householdMemberLeft", "kidLeft", "guestLeft",
  ]) {
    app[`${name}Trigger`] = {
      trigger: async (...args) => {
        const tokens = args[name.startsWith("user") ? 1 : 0];
        calls.push({ name, who: tokens.who });
      },
    };
  }
  for (const { present, guest = false, kid = false } of members) {
    const id = `phone-${devices.length + 1}`;
    devices.push(createDevice({
      _present: present,
      _detectedPresent: present,
      homey,
      error: app.error,
      getData: () => ({ id }),
      getName: () => id,
      getLastSeen: () => 0,
      isGuest: () => guest,
      isKid: () => kid,
      isHouseHoldMember: () => !guest,
      reconcilePresence: SmartPresenceDevice.prototype.reconcilePresence,
      setCapabilityValue: async () => {},
    }));
  }
  return { app, devices, calls };
}

for (const group of [
  { label: "members", guest: false, kid: false },
  { label: "kids", guest: false, kid: true },
  { label: "guests", guest: true, kid: false },
  { label: "guest kids", guest: true, kid: true },
]) {
  for (const present of [false, true]) {
    for (const reverse of [false, true]) {
      test(`overlapping ${group.label} ${present ? "arrivals" : "departures"}, ${reverse ? "reverse" : "forward"} writes`, async () => {
        const { devices, calls } = createHousehold([
          { ...group, present: !present }, { ...group, present: !present },
        ]);
        const writes = devices.map(() => createDeferred());
        devices.forEach((device, index) => {
          device.setCapabilityValue = () => writes[index].promise;
        });
        const transitions = devices.map((device) => device.setDetectedPresent(present, { immediate: true }));
        assert.deepEqual(devices.map((device) => device.getPresenceStatus()), [present, present]);
        assert.deepEqual(calls, []);
        for (const index of reverse ? [1, 0] : [0, 1]) {
          writes[index].resolve();
          await settlesWithin(transitions[index]);
        }

        const aggregateNames = [present ? "firstPersonEntered" : "lastPersonLeft"];
        if (!group.guest) aggregateNames.push(present ? "firstHouseholdMemberArrived" : "lastHouseholdMemberLeft");
        if (group.kid) aggregateNames.push(present ? "firstKidArrived" : "lastKidLeft");
        if (group.guest) aggregateNames.push(present ? "firstGuestArrived" : "lastGuestLeft");
        const who = devices[present ? 0 : 1].getName();
        assert.deepEqual(
          calls.filter(({ name }) => name.startsWith("first") || name.startsWith("last")),
          aggregateNames.map((name) => ({ name, who })),
        );
        const individualNames = present ? ["userEntered", "someoneEntered"] : ["userLeft", "someoneLeft"];
        if (!group.guest) individualNames.push(present ? "householdMemberArrived" : "householdMemberLeft");
        if (group.kid) individualNames.push(present ? "kidArrived" : "kidLeft");
        if (group.guest) individualNames.push(present ? "guestArrived" : "guestLeft");
        for (const device of devices) {
          assert.deepEqual(
            calls.filter((call) => call.who === device.getName() && !call.name.startsWith("first") && !call.name.startsWith("last"))
              .map(({ name }) => name),
            individualNames,
          );
        }
      });
    }
  }
}

for (const present of [false, true]) {
  test(`overlapping kid ${present ? "arrivals" : "departures"} while an adult stays home`, async () => {
    const { devices, calls } = createHousehold([
      { present: !present, kid: true }, { present: !present, kid: true }, { present: true },
    ]);
    await Promise.all(devices.slice(0, 2).map((device) => device.setDetectedPresent(present, { immediate: true })));
    assert.deepEqual(
      calls.filter(({ name }) => name.startsWith("first") || name.startsWith("last")),
      [{ name: present ? "firstKidArrived" : "lastKidLeft", who: devices[present ? 0 : 1].getName() }],
    );
  });
}

for (const guest of [false, true]) {
  test(`a ${guest ? "guest" : "member"} arriving during a pending departure prevents stale empty-group Flows`, async () => {
    const { devices: [leaving, arriving], calls } = createHousehold([
      { present: true }, { present: false, guest },
    ]);
    const write = createDeferred();
    leaving.setCapabilityValue = () => write.promise;
    const departure = leaving.setDetectedPresent(false, { immediate: true });
    await arriving.setDetectedPresent(true);
    write.resolve();
    await settlesWithin(departure);
    assert.deepEqual(
      calls.filter(({ name }) => name.startsWith("last")),
      guest ? [{ name: "lastHouseholdMemberLeft", who: leaving.getName() }] : [],
    );
    assert.equal(calls.filter(({ name }) => name === "userLeft").length, 1);
  });
}

test("real aggregate departure handling suppresses an old leave-return-leave transition", async () => {
  const { devices: [device], calls } = createHousehold([{ present: true }]);
  const write = createDeferred();
  let writes = 0;
  device.setCapabilityValue = async () => {
    if (++writes === 1) await write.promise;
  };
  const oldDeparture = device.setDetectedPresent(false, { immediate: true });
  await device.setDetectedPresent(true);
  await device.setDetectedPresent(false, { immediate: true });
  write.resolve();
  await settlesWithin(oldDeparture);
  assert.deepEqual(calls.filter(({ name }) => name.startsWith("last")), [
    { name: "lastPersonLeft", who: device.getName() },
    { name: "lastHouseholdMemberLeft", who: device.getName() },
  ]);
  assert.equal(calls.filter(({ name }) => name === "userLeft").length, 1);
});

test("a pending last-seen write does not block an online detection", async () => {
  const pendingLastSeen = new Promise(() => {});
  const device = createDevice({
    updateLastSeen: () => pendingLastSeen,
  });

  await settlesWithin(device.setDetectedPresent(true));

  assert.equal(device._detectedPresent, true);
  assert.equal(device._present, true);
});

test("a pending away reconciliation does not block a later online detection", async () => {
  let reconciliationCount = 0;
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    reconcilePresence: async function reconcilePresence() {
      reconciliationCount += 1;
      if (reconciliationCount === 1) {
        return new Promise(() => {});
      }
      this._present = this._detectedPresent;
    },
  });

  device.setDetectedPresent(false, { immediate: true });
  await new Promise((resolve) => setImmediate(resolve));

  await settlesWithin(device.setDetectedPresent(true));

  assert.equal(device._detectedPresent, true);
  assert.equal(device._present, true);
  assert.equal(reconciliationCount, 2);
});

test("a stale persistence completion restores the latest detected state", async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    setStoreValue: async (key, value) => {
      writes.push({ key, value });
      if (writes.length === 1) {
        await firstWrite.promise;
      }
    },
  });

  await device.setDetectedPresent(false, { immediate: true });
  await device.setDetectedPresent(true);
  const pendingPersistence = device._detectedPresencePersistence;
  firstWrite.resolve();
  await pendingPersistence;

  assert.deepEqual(writes.map(({ value }) => value), [false, true]);
});

test("coalesced persistence handles an away-present-away ABA transition", async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    setStoreValue: async (key, value) => {
      writes.push({ key, value });
      if (writes.length === 1) {
        await firstWrite.promise;
      }
    },
  });

  await device.setDetectedPresent(false, { immediate: true });
  await device.setDetectedPresent(true);
  await device.setDetectedPresent(false, { immediate: true });
  const pendingPersistence = device._detectedPresencePersistence;
  firstWrite.resolve();
  await pendingPersistence;

  assert.equal(device._detectedPresent, false);
  assert.deepEqual(writes.map(({ value }) => value), [false, false]);
});

test("a repeated offline probe does not suppress the legitimate departure flows", async () => {
  const capabilityWrite = createDeferred();
  const calls = [];
  const trigger = (name) => ({
    trigger: async () => {
      calls.push(name);
    },
  });
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    getFlowCardTokens: () => ({ who: "Test phone" }),
    homey: {
      app: {
        getPresenceStatus: () => [],
        deviceLeft: async () => calls.push("deviceLeft"),
        householdMemberLeftTrigger: trigger("householdMemberLeft"),
        someoneLeftTrigger: trigger("someoneLeft"),
        userLeftTrigger: trigger("userLeft"),
      },
    },
    isGuest: () => false,
    isHouseHoldMember: () => true,
    isKid: () => false,
    reconcilePresence: SmartPresenceDevice.prototype.reconcilePresence,
    setPresenceStatus: async function setPresenceStatus(present) {
      this._present = present;
      await capabilityWrite.promise;
    },
  });

  const departure = device.setDetectedPresent(false, { immediate: true });
  await new Promise((resolve) => setImmediate(resolve));
  await device.setDetectedPresent(false, { immediate: true });
  capabilityWrite.resolve();
  await settlesWithin(departure);

  assert.deepEqual(calls, ["deviceLeft", "userLeft", "someoneLeft", "householdMemberLeft"]);
});

test("a return suppresses departure flows still waiting on a capability write", async () => {
  const capabilityWrite = createDeferred();
  const calls = [];
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    getFlowCardTokens: () => ({ who: "Test phone" }),
    homey: {
      app: {
        getPresenceStatus: () => [],
        deviceLeft: async () => calls.push("deviceLeft"),
      },
    },
    reconcilePresence: SmartPresenceDevice.prototype.reconcilePresence,
    setPresenceStatus: async function setPresenceStatus(present) {
      this._present = present;
      await capabilityWrite.promise;
    },
  });

  const departure = device.setDetectedPresent(false, { immediate: true });
  await new Promise((resolve) => setImmediate(resolve));
  device._detectedPresent = true;
  capabilityWrite.resolve();
  await settlesWithin(departure);

  assert.deepEqual(calls, []);
});

test("an ABA transition does not dispatch duplicate departure flows", async () => {
  const firstCapabilityWrite = createDeferred();
  const calls = [];
  let capabilityWriteCount = 0;
  const trigger = (name) => ({
    trigger: async () => {
      calls.push(name);
    },
  });
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    getFlowCardTokens: () => ({ who: "Test phone" }),
    homey: {
      app: {
        getPresenceStatus: () => [],
        deviceArrived: async () => calls.push("deviceArrived"),
        deviceLeft: async () => calls.push("deviceLeft"),
        householdMemberArrivedTrigger: trigger("householdMemberArrived"),
        householdMemberLeftTrigger: trigger("householdMemberLeft"),
        someoneEnteredTrigger: trigger("someoneEntered"),
        someoneLeftTrigger: trigger("someoneLeft"),
        userEnteredTrigger: trigger("userEntered"),
        userLeftTrigger: trigger("userLeft"),
      },
    },
    isGuest: () => false,
    isHouseHoldMember: () => true,
    isKid: () => false,
    reconcilePresence: SmartPresenceDevice.prototype.reconcilePresence,
    setPresenceStatus: async function setPresenceStatus(present) {
      this._present = present;
      capabilityWriteCount += 1;
      if (capabilityWriteCount === 1) {
        await firstCapabilityWrite.promise;
      }
    },
  });

  const firstDeparture = device.setDetectedPresent(false, { immediate: true });
  await new Promise((resolve) => setImmediate(resolve));
  await device.setDetectedPresent(true);
  await device.setDetectedPresent(false, { immediate: true });
  firstCapabilityWrite.resolve();
  await settlesWithin(firstDeparture);

  assert.equal(calls.filter((call) => call === "deviceLeft").length, 1);
  assert.equal(calls.filter((call) => call === "userLeft").length, 1);
  assert.equal(calls.filter((call) => call === "someoneLeft").length, 1);
  assert.equal(calls.filter((call) => call === "householdMemberLeft").length, 1);
});

test("a pending aggregate departure notification cannot release stale device flows", async () => {
  const aggregateDeparture = createDeferred();
  const calls = [];
  const trigger = (name) => ({
    trigger: async () => {
      calls.push(name);
    },
  });
  const device = createDevice({
    _detectedPresent: true,
    _present: true,
    getFlowCardTokens: () => ({ who: "Test phone" }),
    homey: {
      app: {
        getPresenceStatus: () => [],
        deviceArrived: async () => {},
        deviceLeft: async () => {
          calls.push("deviceLeft");
          await aggregateDeparture.promise;
        },
        householdMemberArrivedTrigger: trigger("householdMemberArrived"),
        householdMemberLeftTrigger: trigger("householdMemberLeft"),
        someoneEnteredTrigger: trigger("someoneEntered"),
        someoneLeftTrigger: trigger("someoneLeft"),
        userEnteredTrigger: trigger("userEntered"),
        userLeftTrigger: trigger("userLeft"),
      },
    },
    isGuest: () => false,
    isHouseHoldMember: () => true,
    isKid: () => false,
    reconcilePresence: SmartPresenceDevice.prototype.reconcilePresence,
    setPresenceStatus: async function setPresenceStatus(present) {
      this._present = present;
    },
  });

  const departure = device.setDetectedPresent(false, { immediate: true });
  await new Promise((resolve) => setImmediate(resolve));
  await device.setDetectedPresent(true);
  aggregateDeparture.resolve();
  await settlesWithin(departure);

  assert.deepEqual(calls.filter((call) => call.endsWith("Left")), ["deviceLeft"]);
});

test("aggregate arrival Flows stop when their transition becomes stale", async () => {
  const firstPersonTrigger = createDeferred();
  const calls = [];
  let current = true;
  const app = Object.create(SmartPresenceApp.prototype);
  app.log = () => {};
  app.getPresenceStatus = () => [];
  app.homey = {
    app: {
      firstGuestArrivedTrigger: { trigger: async () => calls.push("firstGuest") },
      firstHouseholdMemberArrivedTrigger: { trigger: async () => calls.push("firstHouseholdMember") },
      firstKidArrivedTrigger: { trigger: async () => calls.push("firstKid") },
      firstPersonEnteredTrigger: {
        trigger: async () => {
          calls.push("firstPerson");
          await firstPersonTrigger.promise;
        },
      },
    },
    clock: { getTimezone: () => "UTC" },
    i18n: { getCountry: () => "GB", getLanguage: () => "en" },
  };
  const device = {
    getData: () => ({ id: "phone" }),
    getFlowCardTokens: () => ({ who: "Test phone" }),
    getLastSeen: () => Date.now(),
    getName: () => "Test phone",
    isGuest: () => false,
    isHouseHoldMember: () => true,
    isKid: () => false,
  };

  const notification = app.deviceArrived(device, () => current);
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  firstPersonTrigger.resolve();
  await settlesWithin(notification);

  assert.deepEqual(calls, ["firstPerson"]);
});

test("pending last-seen persistence is kept single-flight", async () => {
  const persistence = createDeferred();
  let capabilityWrites = 0;
  let storeWrites = 0;
  const device = createDevice({
    _lastSeen: 0,
    _lastSeenPersisted: 0,
    _lastSeenPersistence: undefined,
    setLastSeenCapabilities: async () => {
      capabilityWrites += 1;
      await persistence.promise;
    },
    setStoreValue: async () => {
      storeWrites += 1;
    },
    updateLastSeen: SmartPresenceDevice.prototype.updateLastSeen,
  });

  const firstUpdate = device.updateLastSeen();
  const secondUpdate = device.updateLastSeen();
  assert.equal(capabilityWrites, 1);

  persistence.resolve();
  await Promise.all([firstUpdate, secondUpdate]);

  assert.equal(capabilityWrites, 1);
  assert.equal(storeWrites, 1);
  assert.equal(device._lastSeenPersistence, undefined);
});
