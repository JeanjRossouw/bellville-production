# Job cards and time — setting it up

Phase 1 of the job cards & costing spec: workstations with rates, a routing
per product, job cards made when an order is released, the station tablet,
time entries tied to the clock-in register, and the floor board. Planned vs
actual cost (phase 2) and shortages, customer's own fabric and outside work
(phase 3) come after this has run at Bellville for two weeks.

## Once, by the owner

1. **Costing → Overheads & labour**: the monthly overheads (already there if
   you use costing).
2. **Costing → Workstations & steps**:
   - *Productive hours a month*: the hours worked on the floor in a month,
     everyone together (8 people × 45 h × 4.3 weeks ≈ 1 550). Save. This gives
     the overhead an hour.
   - **Add the usual upholstery set-up** (frame shop, cutting, sewing,
     upholstery, QC, packing and their steps), then **Edit** each workstation
     and put in what its people cost an hour, together. Its rate is that plus
     the overhead an hour.
   - Add or rename steps as your floor works. Tick *A check* on QC: it passes,
     or sends the piece back to an earlier step.
3. **Costing → Products → Edit** each product: under *Routing*, its steps in
   order with the minutes for one piece. *Copy the steps of…* fills them from a
   similar product. A product with no steps is built the old way (no cards).
4. **Money → Wages**: the staff. Their names appear on the tablets by
   themselves (names only, no pay details).
5. **Settings → Team**: a login for the tablets with the **Factory floor**
   role.

## Every day

- **Release**: on Factory floor → Planner, **Release to floor** (or move the
  order to In production on Orders). Its cards appear on the stations' tablets:
  the first step Ready, the rest Waiting.
- **The tablet at each station**: open `factorymanager.co.za/app/?station=1`
  (signed in with the floor login), pick the station once. Each person taps
  their name, then **Start** on a job; **Pause** asks why (tea, waiting for
  material, waiting for the frame, rework); **Done** moves the job to the next
  step. Starting a job clocks a person in if they were not; starting another
  job pauses the first; **Clock out** stops whatever is running.
- **The TV**: `factorymanager.co.za/app/?board=1` shows every station, late
  orders in bold, and who is clocked in but not on a job.
- **Managers** (owner, Wages, Costing): Factory floor → Board shows each
  person's time today: clocked in, on jobs, idle. The aim for phase 1 is 90%
  or more of clocked-in time on a job. Orders → **Job cards** on an order shows
  every step with who and how long; **Change** corrects a time entry and keeps
  who changed it and why.
- A timer left running overnight is stopped at that day's clock-out (or the
  time set under Workstations & steps, 17:00 by default) and marked so you can
  check it.

## The spec's open questions, as built

- *Shared tablet or own phone?* Both work: the station screen is shared (tap
  your name), and it fits a phone.
- *Do products have BOMs already?* Yes: Costing already holds each product's
  bill of materials and labour hours. What is new is the routing (steps and
  minutes).
- *Overheads and productive hours for Bellville?* Entered by the owner under
  Costing (above); the numbers are yours to put in.
- *Idle time visible to staff?* Manager-only: the time table shows to the
  owner and roles that see Wages or Profit, never on the TV or the tablet. The
  board lists who is clocked in but not on a job, by name.

## After this change

Publish `couchpotato/firestore.rules` in the Firebase console (project
factory-manager-ece82): it adds the rules for workstations, steps, job cards
and time entries.
