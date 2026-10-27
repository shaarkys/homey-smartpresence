# Duration presence triggers

All 18 existing presence triggers have an additional `_for_duration` variant.
The original cards, arguments, tokens, device identity and capabilities are retained.
No dependency, persisted-data migration or version change is required.

Choose a duration from 1 to 35791 and seconds or minutes. Each qualifying transition
fires once after the selected duration of continuous effective presence or absence.
Wi-Fi detection and manual overrides both feed the same effective presence logic.
The configured away delay is applied before the duration starts.

- Arrival cards require the person who caused the event to stay home.
- First-arrival cards select the first arrival in the relevant group and still
  require that same person to stay home. Other arrivals do not restart its timer.
- Individual departure cards require the person to stay away.
- Last-departure cards require the relevant group to remain empty. Any return in
  that group cancels the timer, even if that person subsequently leaves again.
- Seconds and minutes that describe the same duration share a timer. Each matching
  Flow runs independently, with the original person's `Who` token.
- Reversals cancel pending events. A new qualifying transition starts a new timer.
- Pending timers are discarded on app restart, device stop/deletion or a change to
  guest/kid classification. Changing a classification clears all pending duration
  events because it can change which first/last-group events qualify.
- Saving a different Flow duration applies to the next transition. It does not
  create a new timer for an event already in progress.

## Manual Homey smoke test

These checks require an explicitly authorized test installation. They have not been
performed by the local automated tests. Use manual-only test people to avoid waiting
for Wi-Fi detection; set overrides long enough to outlast the selected durations.

1. Start the app. Confirm it initializes without SDK errors and all new cards appear.
2. With all test people away, create **The first person arrived and stayed home**
   Flows at 5 seconds and 1 minute, each recording the `Who` token. Mark one person
   present. Confirm the instant trigger still fires immediately, and the new Flows
   each fire once at their own deadline with the same person token.
3. Mark that person away before 5 seconds. Confirm neither delayed arrival fires.
   Repeat the arrival and keep them home; confirm a fresh timer fires once.
4. Arrive with two people, then send the first away before the deadline. Confirm the
   first-person duration card does not fire merely because the second remains home.
5. Repeat arrival/departure tests for a specific selected user, household member,
   kid, guest and guest marked as kid. Confirm device cards select the right person.
6. Create last-person and last-household-member departure Flows at 10 seconds. With
   only a member home, mark them away. Return a guest within 10 seconds. Confirm
   last-person is cancelled while last-household-member fires. A returning member
   must cancel both. Repeat for last-guest and last-kid with matching groups.
7. Start a timer and restart the app before expiry. Confirm no old duration event
   fires after restart, and a new away/home transition can start another timer.
8. Start a timer and change guest/kid classification, or delete the test person.
   Confirm the cancelled timer does not fire. Check logs for started, cancelled,
   expired and any underlying SDK error.

One-row changelog: Added duration-based arrival and departure Flow triggers for
users, household members, kids and guests, including first-arrival and last-departure
variants with selectable seconds or minutes.
