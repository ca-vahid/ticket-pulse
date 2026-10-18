# Time-zone data for ICU (Node's Intl)

`2026e/` holds the official ICU time-zone resource files (`zoneinfo64.res`, `metaZones.res`,
`timezoneTypes.res`, `windowsZones.res`, ICU 44+ little-endian) for IANA tzdata 2026e, from
https://github.com/unicode-org/icu-data/tree/main/tzdata/icunew/2026e/44/le (Unicode License v3).

Why: BC is permanent UTC-7 from 1 Nov 2026 (tzdata 2026b). Azure's `NODE|22-lts` image ships
tzdata 2026a, which still moves Vancouver back an hour. The App Service setting
`ICU_TIMEZONE_FILES_DIR=/home/site/wwwroot/tzdata/2026e` makes Node load these files at start,
so Intl, date-fns-tz and node-cron use the current rules. `/health` reports the loaded version as
`app.tzData`, and `utils/tzDataCheck.js` logs an error at boot if Vancouver is still wrong.

To update: download the four files for the new release into a new folder, then point the setting at it.
