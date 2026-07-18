# Operator Questionnaire — Jon / Detroit Shipping Co.

**Purpose:** resolve the open operational unknowns that our design currently
*assumes*. Several code-level decisions are sitting on unvalidated guesses
about how DSC actually runs; Jon's answers are decision inputs, not color.
Record every answer back into `foodhall-sync-project.md` after the meeting.

**UPDATED 2026-07-18** after Zach replies #4–#5 + the parent-tab probes:
Branch A is CONFIRMED platform-side (GoTab owns payment end to end; parent
tab spans vendors; settlement splits natively) — §5 rewritten from "does
this work" to "how does DSC specifically run it." Q15 removed (premise
extinct), Q21 replaced (answered → new production-parity question), Q22b/24b
added (fee policy; card-on-file model — Jon is a design input on the open
pay-before-fire question).

**🏕 CAMP CUT:** 7/21 is a soccer sideline, not a conference room. 🏕-marked
questions are the ones to actually ask Tuesday; everything else is the
agenda for the real DSC walkthrough the demo should win. Best outcome of
camp = the demo lands + a date for that walkthrough.

**Scope discipline:** these are OPERATOR questions. API/platform questions
(settlement path, `scheduled` semantics, webhooks) belong to Zach at GoTab —
deliberately excluded here so the meeting stays on Jon's turf. The one
exception is §7, where Jon's *authorization* is the blocker, not GoTab's
capability.

⭐ = design-blocking: the answer changes code or architecture we've already
written or specced.

---

## 1. The problem & the baseline

*Why: the pitch is "meaningfully better synchronization" — we need his number
for what "better" beats, and 4.1 requires a manual baseline before launch.*

1. 🏕 When a group of 4–6 orders from multiple stalls tonight, what's your gut
   estimate of the gap between the first dish landing and the last?
   > 

2. ⭐🏕 Can we time 5–10 real group orders (first-dish-to-last-dish spread)
   during a normal service before the pilot? Who on your staff could help?
   > 

3. Do diners actually complain about this, or is it a problem you observe but
   they tolerate? What do they say?
   > 

4. Typical group sizes on a busy night — mostly 2–3, or do 6–10 person groups
   matter? (Determines whether we expand sandbox coverage for the many-vendor
   case sooner.)
   > 

## 2. How service physically works today

*Why: this shapes the customer UX and the Ready Board more than anything in
our codebase. "All food ready together" means something different depending on
who moves the food.*

5. ⭐ How does food get from stall to table? Buzzer per stall? Name called?
   Runners? Diner watches a screen? (If each diner fetches their own, our
   "synchronized window" makes the whole table stand up at once — is that
   good or bad in your view?)
   > 

6. How do groups identify where they're sitting — numbered tables? Would QR
   codes per table be acceptable, and who maintains them?
   > 

7. How's guest WiFi / cell coverage inside the hall? (Diners drive this on
   their phones.)
   > 

8. The bar is on GoTab too. Should drinks be part of a synchronized group
   order (fire immediately? fire with food?) or excluded from the app
   entirely for the pilot?
   > 

9. Hours question: when is last call for kitchen orders, and does it vary by
   vendor? (We need to stop accepting group orders before kitchens close.)
   > 

## 3. Kitchen reality, per vendor

*Why: three of our biggest technical assumptions live or die here.*

10. ⭐ Inside one order with several items (say a burger, fries, and a shake
    from the same stall) — does the kitchen work them in PARALLEL (done when
    the slowest is done) or one-after-another? Does it differ by vendor?
    (Our scheduler assumes parallel — `max()` of item times. If a one-cook
    stall works sequentially, that's a per-vendor setting we need.)
    > 

11. ⭐ Which vendors run a GoTab KDS vs printed tickets vs something else —
    and for KDS vendors, what's the STATION setup? (Learned in sandbox:
    "done" only registers when an EXPO/fulfill step completes; a prep-tap on
    a single-station screen never produces the completion timestamp our
    timing telemetry eats. So the real question per vendor: is there an expo
    step, and who performs it?)
    > 

12. ⭐ For KDS vendors: how honest is the bump? Bumped the moment food's in
    the window, or in batches when someone remembers, or at handoff? (Sloppy
    bumping poisons the data our prep-time learning depends on.)
    > 

13. ⭐ When something runs out mid-service, do vendors actually hit
    Unavailable/Hidden in GoTab, or just stop making it and turn people away?
    (Our menu sync trusts GoTab's availability flags — if nobody uses them,
    that trust is misplaced.)
    > 

14. Under a Friday-night rush, do cook times themselves get longer (shared
    grill, batch fryer), or does the queue just get deeper while per-item
    time stays flat? Gut feel per vendor is fine.
    > 

15. ~~If a delayed/scheduled ticket appeared on a KDS ("don't start until
    7:42"), would kitchens respect it?~~ **REMOVED 2026-07-18** — premise
    extinct: in every surviving architecture (our timed waves, or GoTab-held
    scheduledDate), the kitchen only ever sees a ticket AT fire time, as a
    normal ASAP order. Kitchens never need to "respect" anything.
    > n/a

16. Who at each vendor would notice/complain if ticket timing changed? Is
    there a vendor whose head cook we should talk to directly?
    > 

## 4. Prep times & menu data

*Why: honest prep seeds are the scheduler's ground truth (roadmap 3.7:
garbage in, desynchronized food out). GoTab's prepTime field is empty in
practice, so this data has to come from humans.*

17. ⭐ Will vendors sit with us (or you) for 15 minutes each to give honest
    per-item prep times? Who's most likely to sandbag or brag?
    > 

18. Who keeps DSC's GoTab menus current today — each vendor, or a DSC
    manager? How often do menus/prices actually change?
    > 

19. Any items with wildly variable prep (made-to-order vs pre-batched,
    "depends who's cooking")? Those are our hardest scheduling cases —
    naming them early helps.
    > 

## 5. Payments & tabs

*Why (REWRITTEN 2026-07-18): the platform questions are ANSWERED — GoTab
owns payment end to end, one parent tab spans vendors, settlement splits
natively per vendor, cancel = full refund (Zach #4–#5 + our live parent-tab
probes). What remains is how DSC's diners, staff, and account specifically
run it — plus two policy questions the SDK read surfaced, and one design
fork where Jon's instinct is a genuine input.*

20. ⭐ How does a group pay today — separate transactions at each stall, or
    do diners already use GoTab's QR/tab flow at tables? (This is now an
    ADOPTION question: if DSC guests already know GoTab's phone flow —
    verification, saved cards, wallet — our payment surface is familiar
    territory; if they pay at counters, the first-time flow is new friction
    to plan for.)
    > 

21. ⭐ **Production parity** (replaces the answered settlement question): the
    sandbox needed GoTab to enable a parent-location multi-vendor config for
    one-tab-across-vendors to work. Is DSC's REAL GoTab account structured
    as parent + child vendor locations — and who signs off on GoTab making
    that config change in production: you, each vendor, or corporate?
    > 

22. Tipping: per-vendor norms? Would a shared tab change how tips route, and
    would vendors care? (GoTab tabs carry a tipped subtotal — the mechanics
    exist; this is a policy/culture question.)
    > 

22b. ⭐ **Fees**: GoTab payments can carry a customer-facing processing fee
    per payment (we've seen it in their payloads). What happens at DSC today
    — do diners see a fee line on GoTab orders, is it absorbed, and what
    would you want in a group order: fee shown per member, or hidden in
    prices?
    > 

23. What happens today when someone walks away without settling? (Our app
    drops unpaid members' food after a timeout — see next question.)
    > 

24. ⭐ Social check: if one person in a group hasn't paid (or committed a
    card — see 24b) after ~4 minutes, our system drops their items and fires
    the rest of the group's food. Reasonable at DSC, or does that create a
    scene? Better timeout length?
    > 

24b. ⭐ **The model question — your instinct genuinely decides design here.**
    Two ways a group can commit before food fires:
    (a) everyone PAYS their share up front, then food fires;
    (b) everyone ATTACHES A CARD up front (like opening a bar tab), food
        fires on schedule, and each person's charge lands as their food
        goes in.
    (b) is how GoTab tabs natively behave and nobody fronts money before
    cooking starts — but it means charges land during the meal, not before.
    Which fits food-hall groups socially? Which causes fewer scenes when
    someone's card declines?
    > 

25. Is a ~2-minute window between first and last dish "together enough" in
    your book, or does it need to be tighter to feel synchronized? (Our
    default target is 120 seconds; p90 within 4 minutes.)
    > 

## 6. Pilot design & success

*Why: 4.1/4.2 require these agreed BEFORE launch — thresholds negotiated
after launch always get negotiated downward.*

26. ⭐🏕 Which 2–3 vendors would you pick for a weeknight soft launch — who's
    enthusiastic, who's resistant, who has the most reliable kitchen?
    > 

27. Which weeknight is right for a soft launch, and which tables get QR codes
    first?
    > 

28. 🏕 What would make YOU call this a success after 4–8 weeks? (Our proposals:
    median spread ≤ 2 min, beats the manual baseline meaningfully, zero
    "table never fed" incidents, adoption trending up. What's yours —
    covers-per-night? Vendor happiness? Reviews?)
    > 

29. Who's the point person during pilot service — who do we text when
    something looks off, and who texts us?
    > 

30. 🏕 What's the worst thing this could do to your operation? (We want his
    nightmare scenario on record — it becomes a runbook entry.)
    > 

## 7. Business & authorization

31. ⭐🏕 Production go-live needs THREE things on DSC's real GoTab account,
    all learned from the sandbox: (a) the API integration authorized, (b)
    the parent-location multi-vendor config enabled (GoTab had to switch
    this on for our sandbox), (c) client-side payment credentials for the
    wallet. Is authorizing that a Jon decision, a GoTab-rep conversation, or
    both? Any ownership/franchise complication?
    > 

32. Are there other DSC systems in play we haven't heard of (loyalty,
    reservations, events calendar) that group ordering should not collide
    with?
    > 

33. Events nights (concerts, markets): how different is service, and should
    the pilot avoid or target them?
    > 

34. Early monetization sense-check (not a pitch): if this demonstrably tightens
    group service, does a flat monthly fee per venue feel like the right
    shape to you, and roughly what would it need to prove first?
    > 

35. Anything about your diners we should know before putting names/join codes
    on a public board? (We display join codes + vendor statuses, never names,
    on the venue screen — flag if even that's sensitive.)
    > 

---

## After the meeting

- Transcribe answers into `foodhall-sync-project.md` (dated section — they
  are decision inputs, same rule as sandbox findings).
- Q10 decides max() vs sum() per vendor → scheduler config, not code.
- Q11–12 decide which vendors' data feeds prep-time learning (estimator
  design already tolerates missing data — but we should KNOW, not infer).
- Q13 may demote the availability sync from "trustworthy" to "best effort" —
  document either way.
- Q21 (production parity) + Q31 together define the go-live checklist with
  GoTab — fold into the Zach thread once answered.
- Q22b + Q24b feed the open pay-before-fire invariant decision alongside
  Zach's weekend payment findings — do not resolve the invariant before both
  inputs exist.
- Q28's thresholds go into roadmap 4.2 verbatim.
