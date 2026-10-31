# Business architecture

## Use cases for the check-in app

The following overview shows the actors' basic interactions with the app. It describes the use cases, not a particular user interface or application workflow.

```text
Attendee  ------> (Check in on arrival)
Attendee  ------> (Store receipt of check-in)
Organizer ------> (Import participant roster)
Organizer ------> (Record attendee check-in)
Organizer ------> (Monitor check-in status)
```

Registration for the event is maintained by a `Person` referenced from a roster list.  
Check-in is represented by a linked `Practitioner` referenced from a check-in list, with the arrival time recorded on the list entry.  

## Process view

{% include attendance-process.svg %}

Before the event, the organizer imports the expected participants. Each person
is represented as a `Person` in the `RosterList`, which the app uses as the
source for attendee lookup. On arrival, the attendee is matched to that roster
entry and confirms their details. The app backend then records the arrival in
its local FHIR R4 resource store: it creates a `Practitioner` for the checked-in
participant, links it from the `Person`, and adds it to the `CheckinList` with
the arrival time. These related changes are saved together in a FHIR
transaction.

The backend reads the same FHIR resources to provide check-in status and
retrieve saved check-in details. The app generates the attendee's receipt and
QR code locally from those details; the receipt itself is not a FHIR resource.
The QR code contains a `mailto:` link that opens a pre-filled confirmation email
to the attendee's own address, so attendees' phones never need to reach the
check-in app.
