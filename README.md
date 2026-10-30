# Enigma decoder · DevFest Vibe Lounge

A web Enigma I that reads the lounge's machine from
`GET /api/enigma`, tunes in to `GET /api/transmissions` and decodes the
agenda as it goes on air.

- **Live:** the newest transmission is decoded letter by letter, with the
  rotors stepping as it goes.
- **Agenda:** every decoded talk lands in a timetable grouped by time slot.
  The API only holds the last ten transmissions, so the browser keeps what it
  has heard and the timetable fills in as you listen.
- **Machine:** set the rotor start, rings and plugboard, then type on your
  keyboard or tap the keys. Lamps light up and the signal path shows the
  letter after every stage. Any logged transmission can be replayed through it.

Nothing about the wiring is hard-coded: rotors, notches, reflector, rings and
plugs all come from the API, and the page checks itself against the API's
test vector on load.

Plain HTML, CSS and JavaScript with no build step. `enigma.js` is the engine,
`app.js` the page.
