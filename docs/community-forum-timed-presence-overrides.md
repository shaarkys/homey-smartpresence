# Proposal: manual and timed presence overrides

Hey,

I was thinking about an older proposal to make Smart Presence useful for incidental guests, people without a trackable phone, and situations where Wi-Fi detection temporarily gives the wrong result.

What would you think about adding manual and timed presence overrides?

The idea is that the existing presence quick action could temporarily mark any configured person as present or away. Each person would have a configurable default override duration, initially five minutes. Flow actions could provide their own duration in seconds, minutes, or hours:

- Keep a person present
- Keep a person away
- Resume automatic presence detection

While an override is active, the device would show whether it is being kept present or away and how many whole minutes remain. The countdown would only update once per displayed minute, while the override itself would still end at the exact configured time.

For devices with an IP address, normal Wi-Fi checks would continue in the background. They would not cancel an active override, but their latest result would take over immediately when the timer ends. Existing devices would remain in automatic mode unless someone explicitly uses the new control, so current behaviour and existing Flows would remain compatible.

It would also be possible to add a manually controlled person without entering an IP address. This could be used as a reusable “General guest” device, but the feature would not be limited to guests—it would work for household members and kids as well.

For example, a Flow could keep “General guest” present for three hours when guest mode is enabled. At the end of those three hours, the device would automatically return to its normal state.

Would this approach fit how you use Smart Presence? In particular, would you prefer the quick action to default to a short temporary override, or should an indefinite “until cleared” option be more prominent?
