"use strict";

const MAX_TIMER_DELAY = 2147483647;
const GROUPS = {
  person: () => true,
  household_member: (device) => device.isHouseHoldMember(),
  kid: (device) => device.isKid(),
  guest: (device) => device.isGuest(),
};

const DEFINITIONS = [
  { id: "user_entered", present: true, deviceCard: true },
  { id: "user_left", present: false, deviceCard: true },
  { id: "someone_entered", present: true },
  { id: "someone_left", present: false },
  ...["household_member", "kid", "guest"].flatMap((group) => [
    { id: `${group}_arrived`, present: true, group },
    { id: `${group}_left`, present: false, group },
  ]),
  ...Object.keys(GROUPS).flatMap((group) => [
    { id: group === "person" ? "first_person_entered" : `first_${group}_arrived`, present: true, group, aggregate: true },
    { id: `last_${group}_left`, present: false, group, aggregate: true },
  ]),
];

function durationInMillis(args) {
  const duration = Number(args.duration);
  const multiplier = { seconds: 1000, minutes: 60000 }[args.unit];
  const milliseconds = duration * multiplier;
  return Number.isFinite(duration) && duration >= 1 && duration <= 35791 && Number.isFinite(milliseconds)
    && milliseconds >= 1 && milliseconds <= MAX_TIMER_DELAY ? milliseconds : null;
}

class DurationTriggers {
  constructor(app) {
    this.app = app;
    this.pending = new Set();
    this.dispatches = new Map();
    this.sequence = 0;
    this.cards = DEFINITIONS.map((definition) => {
      const id = `${definition.id}_for_duration`;
      const card = definition.deviceCard
        ? app.homey.flow.getDeviceTriggerCard(id) : app.homey.flow.getTriggerCard(id);
      card.registerRunListener((args, state) => {
        const event = this.dispatches.get(state?.dispatchId);
        return !!event && durationInMillis(args) === state.duration && this.isValid(event);
      });
      return { ...definition, card };
    });
  }

  belongs(status, group) {
    return group === "person" || (group === "household_member" && !status.guest)
      || (group === "kid" && status.kid) || (group === "guest" && status.guest);
  }

  transition(device, present, previousStatus, isCurrent) {
    if (this.stopped || device._deleted || device._durationTriggersStopped) return;
    // Invalidate synchronously, before capability writes or argument lookups can wait.
    this.cancelWhere((event) => event.device === device
      || (present && event.definition.aggregate && !event.definition.present
        && GROUPS[event.definition.group](device)), "presence changed");

    for (const definition of this.cards) {
      if (definition.present !== present || (definition.group && !GROUPS[definition.group](device))) continue;
      if (definition.aggregate && previousStatus.some((status) => status.id !== device.getData().id
        && status.present && this.belongs(status, definition.group))) continue;
      const event = {
        definition, device, isCurrent, startedAt: Date.now(),
        tokens: device.getFlowCardTokens(), timers: new Set(), cancelled: false,
      };
      this.pending.add(event);
      void this.schedule(event).catch((err) => {
        this.cancelWhere((candidate) => candidate === event, "failed");
        this.app.error(`Duration trigger ${definition.id} failed`, err);
      });
    }
  }

  isValid(event) {
    if (this.stopped || event.cancelled || event.device._deleted || event.device._durationTriggersStopped || !event.isCurrent()
      || event.device.getPresenceStatus() !== event.definition.present) return false;
    return !event.definition.aggregate || event.definition.present
      || !this.app.getPresenceStatus().some((status) => status.present && this.belongs(status, event.definition.group));
  }

  async schedule(event) {
    const { definition, device } = event;
    const values = await (definition.deviceCard
      ? definition.card.getArgumentValues(device) : definition.card.getArgumentValues());
    if (!this.isValid(event)) {
      this.pending.delete(event);
      return;
    }
    const durations = new Set(values.map(durationInMillis).filter((duration) => duration !== null));
    if (!durations.size) {
      this.pending.delete(event);
      return;
    }
    event.remaining = durations.size;
    for (const duration of durations) {
      const timer = this.app.homey.setTimeout(() => {
        event.timers.delete(timer);
        void this.fire(event, duration);
      }, Math.max(0, event.startedAt + duration - Date.now()));
      event.timers.add(timer);
    }
    this.app.log(`Duration trigger ${definition.id} started (${durations.size} duration(s))`);
  }

  async fire(event, duration) {
    const dispatchId = ++this.sequence;
    try {
      if (!this.isValid(event)) {
        this.app.log(`Duration trigger ${event.definition.id} skipped (presence changed)`);
        return;
      }
      // Flow state crosses the SDK boundary, so keep it JSON serializable.
      const state = { duration, dispatchId };
      this.dispatches.set(dispatchId, event);
      this.app.log(`Duration trigger ${event.definition.id} expired (${duration} ms)`);
      if (event.definition.deviceCard) {
        await event.definition.card.trigger(event.device, event.tokens, state);
      } else {
        await event.definition.card.trigger(event.tokens, state);
      }
    } catch (err) {
      this.app.error(`Duration trigger ${event.definition.id} failed`, err);
    } finally {
      this.dispatches.delete(dispatchId);
      event.remaining -= 1;
      if (!event.remaining) this.pending.delete(event);
    }
  }

  cancelWhere(predicate, reason) {
    for (const event of this.pending) {
      if (!predicate(event)) continue;
      event.cancelled = true;
      for (const timer of event.timers) this.app.homey.clearTimeout(timer);
      this.pending.delete(event);
      if (event.timers.size) this.app.log(`Duration trigger ${event.definition.id} cancelled (${reason})`);
    }
  }

  clear(reason) {
    this.cancelWhere(() => true, reason);
  }

  stop(reason) {
    this.stopped = true;
    this.clear(reason);
  }
}

module.exports = { DurationTriggers, DEFINITIONS, durationInMillis };
