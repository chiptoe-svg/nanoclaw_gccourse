---
name: weather
description: Get current weather for any city using the free Open-Meteo API (no API key needed). Use whenever the user asks about weather, temperature, or conditions somewhere.
allowed-tools: Bash(python3:*)
---

# Weather

Run the bundled script with a city name:

```bash
python3 /app/skills/weather/scripts/weather.py "Clemson, SC"
```

It prints current conditions — temperature, feels-like, humidity, wind, and
precipitation — for example:

```
Weather in Clemson, South Carolina, United States: partly cloudy
  temperature: 78.3°F (feels like 80.1°F)
  humidity:    62%
  wind:        5.8 mph
  precip:      0.0 mm
```

Relay the result conversationally. If the user doesn't name a place, ask —
or default to Clemson, SC.

## How it works (for the curious)

`scripts/weather.py` is ~50 lines of plain Python, standard library only:

1. **Geocode** the city name to latitude/longitude via
   `geocoding-api.open-meteo.com`.
2. **Fetch** current conditions for those coordinates from
   `api.open-meteo.com`.
3. **Print** a small human-readable report.

No API key, no accounts — Open-Meteo is free for non-commercial use.
