"use strict";

const Homey = require("homey");

function formatLastSeen(timestamp, homey) {
  const timezone = homey.clock.getTimezone();
  const language = homey.i18n?.getLanguage?.();
  const country = homey.i18n?.getCountry?.();
  const locale = [language, country].filter(Boolean).join("-") || "en-US";

  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

module.exports = class SmartPresenceApp extends Homey.App {

  log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [SmartPresence log : `, ...args);
  }

  async onInit() {
    try {
      await this.initFlows();
      this.log("SmartPresenceApp is running...");
    } catch (err) {
      this.log("onInit error", err);
    }
  }

  async initFlows() {
    this.firstGuestArrivedTrigger = this.homey.flow.getTriggerCard("first_guest_arrived");

    this.firstHouseholdMemberArrivedTrigger = this.homey.flow.getTriggerCard("first_household_member_arrived");

    this.firstKidArrivedTrigger = this.homey.flow.getTriggerCard("first_kid_arrived");

    this.firstPersonEnteredTrigger = this.homey.flow.getTriggerCard("first_person_entered");

    this.guestArrivedTrigger = this.homey.flow.getTriggerCard("guest_arrived");

    this.guestLeftTrigger = this.homey.flow.getTriggerCard("guest_left");

    this.householdMemberArrivedTrigger = this.homey.flow.getTriggerCard("household_member_arrived");

    this.householdMemberLeftTrigger = this.homey.flow.getTriggerCard("household_member_left");

    this.kidArrivedTrigger = this.homey.flow.getTriggerCard("kid_arrived");

    this.kidLeftTrigger = this.homey.flow.getTriggerCard("kid_left");

    this.lastGuestLeftTrigger = this.homey.flow.getTriggerCard("last_guest_left");

    this.lastHouseholdMemberLeftTrigger = this.homey.flow.getTriggerCard("last_household_member_left");

    this.lastKidLeftTrigger = this.homey.flow.getTriggerCard("last_kid_left");

    this.lastPersonLeftTrigger = this.homey.flow.getTriggerCard("last_person_left");

    this.someoneEnteredTrigger = this.homey.flow.getTriggerCard("someone_entered");

    this.someoneLeftTrigger = this.homey.flow.getTriggerCard("someone_left");

    this.userEnteredTrigger = this.homey.flow.getDeviceTriggerCard("user_entered");

    this.userLeftTrigger = this.homey.flow.getDeviceTriggerCard("user_left");

    this.homey.flow.getConditionCard("a_household_member_is_home").registerRunListener((args, state) => this.householdMemberIsHome(args, state));

    this.homey.flow.getConditionCard("kids_at_home").registerRunListener((args, state) => this.kidsAtHome(args, state));

    this.homey.flow.getConditionCard("having_guests").registerRunListener((args, state) => this.havingGuests(args, state));

    this.homey.flow.getConditionCard("someone_at_home").registerRunListener((args, state) => this.someoneAtHome(args, state));

    this.homey.flow.getConditionCard("user_at_home").registerRunListener((args, state) => args.device.userAtHome());
  }

  async householdMemberIsHome(args, state) {
    return this.getPresenceStatus().filter((d) => d.present && !d.guest).length > 0;
  }

  async kidsAtHome(args, state) {
    return this.getPresenceStatus().filter((d) => d.present && d.kid).length > 0;
  }

  async havingGuests(args, state) {
    return this.getPresenceStatus().filter((d) => d.present && d.guest).length > 0;
  }

  async someoneAtHome(args, state) {
    return this.getPresenceStatus().filter((d) => d.present).length > 0;
  }

  getPresenceStatus() {
    const status = [];
    const driver = this.homey.drivers.getDriver("smart_presence");
    const devices = driver.getDevices();
    for (let device of devices) {
      status.push({
        id: device.getData().id,
        present: device.getPresenceStatus(),
        kid: device.isKid(),
        guest: device.isGuest(),
        lastSeen: device.getLastSeen(),
      });
    }
    return status;
  }

  async deviceArrived(device) {
    const currentPresenceStatus = this.getPresenceStatus();
    const tokens = device.getFlowCardTokens();
    const deviceId = device.getData().id;
    const lastSeenFormatted = formatLastSeen(device.getLastSeen(), this.homey);
    this.log(`Device ${device.getName()} Arrived. Previous last seen: ${lastSeenFormatted}`);

    let isFirstPerson = true;
    let isFirstHouseholdMember = device.isHouseHoldMember();
    let isFirstKid = device.isKid();
    let isFirstGuest = device.isGuest();

    for (const status of currentPresenceStatus) {
      if (status.id !== deviceId && status.present) {
        isFirstPerson = false;
        if (!status.guest) isFirstHouseholdMember = false;
        if (status.kid) isFirstKid = false;
        if (status.guest) isFirstGuest = false;
      }
    }

    if (isFirstPerson) {
      await this.homey.app.firstPersonEnteredTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Arrived as First Person. <<<`);
    }
    if (isFirstHouseholdMember) {
      await this.homey.app.firstHouseholdMemberArrivedTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Arrived as First HouseHold Member. <<<`);
    }
    if (isFirstKid) {
      await this.homey.app.firstKidArrivedTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Arrived as First Kid. <<<`);
    }
    if (isFirstGuest) {
      await this.homey.app.firstGuestArrivedTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Arrived as First Guest. <<<`);
    }
  }

  async deviceLeft(device, tokens) {
    const currentPresenceStatus = this.getPresenceStatus();
    const lastSeenFormatted = formatLastSeen(device.getLastSeen(), this.homey);
    this.log(`Device ${device.getName()} Left. Last Seen: ${lastSeenFormatted}`);

    let isLastPerson = true;
    let isLastHouseholdMember = device.isHouseHoldMember();
    let isLastKid = device.isKid();
    let isLastGuest = device.isGuest();

    for (const status of currentPresenceStatus) {
      if (status.id !== device.getData().id && status.present) {
        isLastPerson = false;
        if (!status.guest) isLastHouseholdMember = false;
        if (status.kid) isLastKid = false;
        if (status.guest) isLastGuest = false;
      }
    }

    if (isLastPerson) {
      await this.homey.app.lastPersonLeftTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Left as Last Person  <<<`);
    }
    if (isLastHouseholdMember) {
      await this.homey.app.lastHouseholdMemberLeftTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Left as Last House Hold Member. <<<`);
    }
    if (isLastKid) {
      await this.homey.app.lastKidLeftTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Left as Last Kid. <<<`);
    }
    if (isLastGuest) {
      await this.homey.app.lastGuestLeftTrigger.trigger(tokens, {}).catch(this.error);
      this.log(`>>> Device ${device.getName()} Left as Last Guest. <<<`);
    }
  }
};
