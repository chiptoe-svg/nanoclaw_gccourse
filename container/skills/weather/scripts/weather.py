#!/usr/bin/env python3
"""Current weather for a city, via the free Open-Meteo API (no API key).

Usage:  python3 weather.py <city name>
Example: python3 weather.py "Clemson, SC"
"""
import json
import sys
import urllib.parse
import urllib.request

# WMO weather-interpretation codes -> short description.
WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "depositing rime fog",
    51: "light drizzle", 53: "drizzle", 55: "dense drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
    85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}


def fetch_json(url):
    """GET a URL and parse the JSON response."""
    with urllib.request.urlopen(url, timeout=15) as resp:
        return json.load(resp)


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: weather.py <city name>   e.g.  weather.py "Clemson, SC"')
    city = " ".join(sys.argv[1:])

    # Step 1: city name -> coordinates. The geocoder wants a bare place name,
    # so if "Clemson, SC" finds nothing, retry with just "Clemson".
    def geocode(name):
        data = fetch_json(
            "https://geocoding-api.open-meteo.com/v1/search?count=1&name="
            + urllib.parse.quote(name)
        )
        return (data.get("results") or [None])[0]

    place = geocode(city) or geocode(city.split(",")[0].strip())
    if not place:
        sys.exit(f"city not found: {city}")

    # Step 2: coordinates -> current conditions.
    wx = fetch_json(
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={place['latitude']}&longitude={place['longitude']}"
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,"
        "precipitation,weather_code,wind_speed_10m"
        "&temperature_unit=fahrenheit&wind_speed_unit=mph"
    )
    cur = wx["current"]

    # Step 3: print a small report.
    where = ", ".join(
        p for p in [place.get("name"), place.get("admin1"), place.get("country")] if p
    )
    desc = WEATHER_CODES.get(cur["weather_code"], f"weather code {cur['weather_code']}")
    print(f"Weather in {where}: {desc}")
    print(f"  temperature: {cur['temperature_2m']}°F (feels like {cur['apparent_temperature']}°F)")
    print(f"  humidity:    {cur['relative_humidity_2m']}%")
    print(f"  wind:        {cur['wind_speed_10m']} mph")
    print(f"  precip:      {cur['precipitation']} mm")


if __name__ == "__main__":
    main()
