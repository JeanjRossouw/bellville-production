# Job cards, time and job costing — setting it up

Phases 1 and 2 of the job cards & costing spec.

- **Phase 1**: workstations with rates, a routing per product, job cards made
  when an order is released, the station tablet, time entries tied to the
  clock-in register, and the floor board.
- **Phase 2**: planned against actual cost per order: materials issued from
  the job cards, the order cost card, the margin report and suggested
  standard times.

- **Phase 3**: the shortage check before release, the customer's own fabric
  (COM) and outside work.

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

## Planned against actual (phase 2)

- **Where each material is used**: Costing → Products → Edit, each line of
  the bill says the step that uses it (*used at Build frame*, *used at Cut
  fabric*…); no step means the first one.
- **Released**: the order keeps its planned cost, frozen: the bill × qty at
  that day's prices, and each step's standard minutes at its station's rate.
  A price or rate change later does not move it.
- **On the floor**: starting a step issues its materials as planned (at the
  price of the day). At **Done** the person sees them filled in and changes
  only what was different. Using more than planned needs a reason: offcut
  wasted, cutting error, pattern match, customer change. **A material not on
  the list** adds one. The shelf count moves by the difference (the bill came
  off when the order was released, as before).
- **Actual cost** = materials issued + minutes timed × the rate of the day +
  rework (time on rework cards, all of it loss). Paused time is not charged.
  It is worked out when the order is done, when a manager corrects a time,
  and whenever its cost card is opened.
- **Orders → Cost** (owner, Costing, Profit): planned against actual per
  material and per step, rework, the total, and the margin on the price excl.
  VAT, in rand and %. While the order is on the floor, steps not reached show
  *not yet* and the totals compare what is done so far. Variance: within 5%
  normal, 5–15% a warning, over 15% flagged. **Print** gives a black-and-white
  copy with asterisks instead of colour.
- **Money → Profit → Per order: planned against actual** (last 30 or 90
  days): margin per order worst first, margin per product, labour against
  standard per step (which step always runs over), rework by month and by
  whose step it went back to, idle time per person, and **suggested standard
  times** (the average of the last ten runs); **Use** puts one into the
  product's routing for orders released after that.
- The spec's measure for phase 2: actual cost per order within 10% of a
  manual check on 5 sample orders.

## Shortages, COM and outside work (phase 3)

- **The shortage check**: moving an order into production (Release to floor,
  or In production on Orders) first compares what it takes with the shelf.
  All there: it goes straight on. Anything short, you see each material: OK,
  short by how much, or on order (enough coming, with the purchase order and
  its date). **Release anyway** puts it on the floor with a red *material
  short* tag until the shelf is right again; **Order what is short** drafts
  the supplier's purchase order (more than one supplier: Stock → Order now).
- **The purchase list** is Stock → Materials → **Order now**: what is short,
  grouped by supplier, one purchase order each, and now with the orders each
  material is for (orders released short first).
- **The customer's own fabric (COM)**: tick *The customer supplies the
  fabric* on the order. Set a **COM handling fee** under Settings and ticking
  adds it to the price. The fabric is left out of the shortage check, is not
  taken from the shelf and costs R0; the job cards show **COM** so cutting
  uses their roll. The stock room books the roll in against that order only
  (Stock room → Client fabric → Fabric arrived), and the metres cutting takes
  are written beside it.
- **Outside work**: under Costing → Workstations & steps, a step can be
  *done outside, by a supplier* (frames bought in, CNC parts, spraying), with
  the supplier, their price a piece and the days it usually takes. Its job
  card is not on any tablet: Factory floor → **Outside work** lists what is
  ready to send, what is at suppliers (overdue first) and what is back with
  the invoice to come. **Send out** (supplier, due back, quote), **Back in**
  (the next step becomes Ready), **Invoice** (the amount becomes the step's
  actual cost; the quote is its plan). Overdue work shows on Today and in an
  *At suppliers* column on the board; the cost card has an Outside work row.
- The spec's measure for phase 3: a week of releases with no surprise
  material stoppages on the floor.

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
factory-manager-ece82): it adds the rules for workstations, steps, job cards,
time entries, material issues and the customer's fabric (comStock).
