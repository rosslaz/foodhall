# Operator Questionnaire — Jon / Detroit Shipping Co.

**Purpose:** resolve the open operational unknowns that our design currently
*assumes*. Several code-level decisions are sitting on unvalidated guesses
about how DSC actually runs; Jon's answers are decision inputs, not color.
Record every answer back into `foodhall-sync-project.md` after the meeting.

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

1. When a group of 4–6 orders from multiple stalls tonight, what's your gut
   estimate of the gap between the first dish landing and the last?
   > 

2. ⭐ Can we time 5–10 real group orders (first-dish-to-last-dish spread)
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

11. ⭐ Which vendors run a GoTab KDS screen vs printed tickets vs something
    else? (Our timing telemetry only exists for kitchens that BUMP tickets.)
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

15. If a delayed/scheduled ticket appeared on a KDS ("don't start until
    7:42"), would kitchens respect it — or start it the moment they see it?
    Have they ever handled scheduled orders (catering, online pickup)?
    > 

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

*Why: our recorded decision is Branch A — GoTab owns payment on a shared tab,
our app never touches money. That only works if shared tabs work at DSC the
way we think.*

20. ⭐ How does a group pay today — separate transactions at each stall, or
    do shared/open tabs across vendors actually get used at DSC?
    > 

21. ⭐ When one tab spans multiple vendors + the bar, how does the money
    split to each vendor's account — automatic in GoTab, or DSC does
    accounting? Any friction we'd inherit by driving orders onto one tab?
    > 

22. Tipping: per-vendor norms? Would a shared tab change how tips route, and
    would vendors care?
    > 

23. What happens today when someone walks away without settling? (Our app
    drops unpaid members' food after a timeout — see next question.)
    > 

24. ⭐ Social check: if one person in a group hasn't paid after ~4 minutes,
    our system drops their items and fires the rest of the group's food.
    Reasonable at DSC, or does that create a scene? Better timeout length?
    > 

25. Is a ~2-minute window between first and last dish "together enough" in
    your book, or does it need to be tighter to feel synchronized? (Our
    default target is 120 seconds; p90 within 4 minutes.)
    > 

## 6. Pilot design & success

*Why: 4.1/4.2 require these agreed BEFORE launch — thresholds negotiated
after launch always get negotiated downward.*

26. ⭐ Which 2–3 vendors would you pick for a weeknight soft launch — who's
    enthusiastic, who's resistant, who has the most reliable kitchen?
    > 

27. Which weeknight is right for a soft launch, and which tables get QR codes
    first?
    > 

28. What would make YOU call this a success after 4–8 weeks? (Our proposals:
    median spread ≤ 2 min, beats the manual baseline meaningfully, zero
    "table never fed" incidents, adoption trending up. What's yours —
    covers-per-night? Vendor happiness? Reviews?)
    > 

29. Who's the point person during pilot service — who do we text when
    something looks off, and who texts us?
    > 

30. What's the worst thing this could do to your operation? (We want his
    nightmare scenario on record — it becomes a runbook entry.)
    > 

## 7. Business & authorization

31. ⭐ Production GoTab access: the POC runs against a sandbox today. Going
    live at DSC needs an API integration authorized on DSC's REAL GoTab
    account — is that a Jon decision, a GoTab-rep conversation, or both? Any
    ownership/franchise complication?
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
- Q20–21 confirm or kill Branch A assumptions before the Zach conversation.
- Q28's thresholds go into roadmap 4.2 verbatim.
