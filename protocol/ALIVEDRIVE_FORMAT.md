# AliveDrive PDR 2.5 Telemetry Format

Reverse-engineered from the `adco` data track in MP4 files produced by the
AliveDrive / Cosworth Performance Data Recorder found in 2025-2026 GM vehicles
including Cadillac CT5-V Blackwing, Corvette Z06, and Corvette Stingray.

Two format variants exist, determined by the MMP firmware version (see §14.2):

| Variant | MMP Version | Packet Size | 100 Hz Frame | 1 Hz Frame | Wheel Speed Type |
|---------|-------------|-------------|--------------|------------|-----------------|
| Legacy  | gen 1 (any) or gen 2 MMP ≤ 3 | 3247 bytes | 17 bytes | 31 bytes | u16 angular velocity |
| MMP v4+ | gen 2 MMP ≥ 4 | 4050 bytes | 25 bytes | 34 bytes | float32 m/s |

This document covers the **AliveDrive PDR 2.5** format, which is distinct from
the older **Marlin** format (handler `ctbx`, codec `mrld`/`mrlv`/`marl`) used
in Corvette C7/C8 PDR systems.

---

## 1. MP4 Container Layout

The MP4 file contains four streams:

| Stream | Type | Details |
|--------|------|---------|
| 0 | H.264 video | 1920x1080 @ ~30 fps |
| 1 | AliveDrive data | handler `adrv`, codec `adco` |
| 2 | AAC audio | stereo, 48 kHz |
| 3 | MJPEG | thumbnail / poster frame |

### 1.1 Identifying the Data Track

Inside `moov/trak/mdia/hdlr`, look for `handler_type == "adrv"`.
Alternatively, inside `moov/trak/mdia/minf/stbl/stsd`, the first sample entry
will have codec tag `adco`.

The `hdlr` name string is `"AliveDrive PDR 2.5"`.

### 1.2 Custom Sub-Boxes Inside `adco`

The `adco` sample description entry (inside `stsd`) contains these nested boxes:

| Box | Purpose |
|------|---------|
| `advi` | Version / identifier info |
| `adop` | Outing properties (track name, vehicle, GPS bounding box, etc.) |
| `adcp` | Channel parameter definitions (59 channels with Cosworth namespace names, scale factors, offsets, and min/max ranges) |
| `adcr` | Rate table — defines rate groups, periods, and channel assignments |
| `adud` | Unit definitions (maps unit IDs to Cosworth namespace unit names) |
| `adeg` | Event definitions (performance timing triggers) |

---

## 2. Channel Definitions (`adcp`)

59 channels are defined, numbered 0–58. Authoritative names were recovered from
the `adcp` box where each channel is identified by its full Cosworth namespace
string (e.g., `com.cosworth.channel.speed`).

### 2.1 Complete Channel Table

| Ch | Cosworth Name | Short Name | Rate Group | Unit | Scale | Offset |
|----|---------------|-----------|-----------|------|-------|--------|
| 0 | channel.speed | speed | 2 (10 Hz) | velocity.si | 0.00434028 | 0 |
| 1 | channel.location.latitude | latitude | 2 (10 Hz) | angle.si | 1.7453293e-9 | 0 |
| 2 | channel.location.longitude | longitude | 2 (10 Hz) | angle.si | 1.7453293e-9 | 0 |
| 3 | channel.location.altitude | altitude | 2 (10 Hz) | length.si | 0.001 | 0 |
| 4 | channel.location.heading | heading | 2 (10 Hz) | angle.si | 1.745329252e-7 | 0 |
| 5 | channel.location.fixquality | fixquality | 2 (10 Hz) | none.none | 1.0 | 0 |
| 6 | channel.location.satellites | satellites | 2 (10 Hz) | none.none | 1.0 | 0 |
| 7 | channel.stability.antilockbrakingsystem | ABS | 2 (10 Hz) | none.none | enum | — |
| 8 | channel.accelerometer.device.x | accel.device.x | 1 (50 Hz) | acceleration.si | 9.80665 | 0 |
| 9 | channel.accelerometer.device.y | accel.device.y | 1 (50 Hz) | acceleration.si | 9.80665 | 0 |
| 10 | channel.accelerometer.device.z | accel.device.z | 1 (50 Hz) | acceleration.si | 9.80665 | 0 |
| 11 | channel.accelerometer.vehicle.x | accel.vehicle.x | 1 (50 Hz) | acceleration.si | 9.80665 | 0 |
| 12 | channel.accelerometer.vehicle.y | accel.vehicle.y | 1 (50 Hz) | acceleration.si | 9.80665 | 0 |
| 13 | channel.accelerometer.vehicle.z | accel.vehicle.z | 1 (50 Hz) | acceleration.si | 9.80665 | 0 |
| 14 | channel.throttle.position | throttle | 2 (10 Hz) | proportion.si | 0.00392157 | 0 |
| 15 | channel.propulsion.electricmotor.powerlevel | emotor.powerlevel | 5 (1 Hz) | proportion.si | 0.01 | 0 |
| 16 | channel.brake.position | brake.position | 0 (100 Hz) | proportion.si | 0.00392157 | 0 |
| 17 | channel.gear | gear | 3 (5 Hz) | none.none | enum | — |
| 18 | channel.battery.highvoltage.usablecharge | HV.battery.charge | 5 (1 Hz) | proportion.si | 1.5259e-5 | 0 |
| 19 | channel.driveperformancemode | drive.mode | 5 (1 Hz) | none.none | enum | — |
| 20 | channel.propulsion.electricmotor.axleavailable | emotor.axle | 5 (1 Hz) | none.none | enum | — |
| 21 | channel.propulsion.electricmotor.temperature.rotor | emotor.temp.rotor | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 22 | channel.propulsion.electricmotor.temperature.stator | emotor.temp.stator | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 23 | channel.engine.temperature.coolant | engine.temp.coolant | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 24 | channel.engine.pressure.airintake.boost | boost | 2 (10 Hz) | pressure.si | 1000 | 0 |
| 25 | channel.engine.temperature.airintake | engine.temp.airintake | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 26 | channel.engine.pressure.oil | oil.pressure | 4 (2 Hz) | pressure.si | 4000 | 0 |
| 27 | channel.engine.temperature.oil | engine.temp.oil | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 28 | channel.propulsion.engine.powerlevel | engine.powerlevel | 5 (1 Hz) | proportion.si | 0.01 | 0 |
| 29 | channel.enginespeed | engine.speed | 0 (100 Hz) | angularvelocity.si | 0.0261799388 | 0 |
| 30 | channel.propulsion.engine.startstop | engine.startstop | 3 (5 Hz) | none.none | enum | — |
| 31 | channel.propulsion.engine.torque | engine.torque | 0 (100 Hz) | torque.si | 0.5 | -848.0 |
| 32 | channel.temperature.outsideair | outside.air.temp | 5 (1 Hz) | temperature.si | 0.5 | 233.15 K |
| 33 | channel.stability.electronicstabilitycontrol | ESC | 3 (5 Hz) | none.none | enum | — |
| 34 | channel.engine.level.fuel | fuel.level | 5 (1 Hz) | proportion.si | 0.003921 | 0 |
| 35 | channel.battery.highvoltage.temperature.average | HV.battery.temp.avg | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 36 | channel.battery.highvoltage.temperature.maximum | HV.battery.temp.max | 5 (1 Hz) | temperature.si | 0.5 | 233.15 K |
| 37 | channel.battery.highvoltage.temperature.minimum | HV.battery.temp.min | 5 (1 Hz) | temperature.si | 0.5 | 233.15 K |
| 38 | channel.odometer.distance | odometer | 5 (1 Hz) | length.si | 15.625 | 0 |
| 39 | channel.performancetractionmanagement | PTM.mode | 5 (1 Hz) | none.none | enum | — |
| 40 | channel.propulsion.electricmotor.power | emotor.power | 2 (10 Hz) | power.si | 500 | 0 |
| 41 | channel.propulsion.engine.power | engine.power | 2 (10 Hz) | power.si | 500 | 0 |
| 42 | channel.steeringangle | steering.angle | 0 (100 Hz) | angle.si | 0.001090831 | 0 |
| 43 | channel.stability.tractioncontrolsystem | TCS | 3 (5 Hz) | none.none | enum | — |
| 44 | channel.transmission.oil.temperature | trans.oil.temp | 5 (1 Hz) | temperature.si | 1.0 | 233.15 K |
| 45 | channel.tire.pressure.front.left | tire.pressure.FL | 5 (1 Hz) | pressure.si | 4000 | 0 |
| 46 | channel.tire.pressure.front.right | tire.pressure.FR | 5 (1 Hz) | pressure.si | 4000 | 0 |
| 47 | channel.tire.pressure.rear.left | tire.pressure.RL | 5 (1 Hz) | pressure.si | 4000 | 0 |
| 48 | channel.tire.pressure.rear.right | tire.pressure.RR | 5 (1 Hz) | pressure.si | 4000 | 0 |
| 49 | channel.tire.temperature.front.left | tire.temp.FL | 5 (1 Hz) | temperature.si | 1.0 | 253.15 K |
| 50 | channel.tire.temperature.front.right | tire.temp.FR | 5 (1 Hz) | temperature.si | 1.0 | 253.15 K |
| 51 | channel.tire.temperature.rear.left | tire.temp.RL | 5 (1 Hz) | temperature.si | 1.0 | 253.15 K |
| 52 | channel.tire.temperature.rear.right | tire.temp.RR | 5 (1 Hz) | temperature.si | 1.0 | 253.15 K |
| 53 | channel.stability.vehiclestabilityenhancement | VSE | 5 (1 Hz) | none.none | enum | — |
| 54 | channel.wheel.speed.front.left | wheel.speed.FL | 0 (100 Hz) | angularvelocity.si | 0.0251327412 | 0 |
| 55 | channel.wheel.speed.front.right | wheel.speed.FR | 0 (100 Hz) | angularvelocity.si | 0.0251327412 | 0 |
| 56 | channel.wheel.speed.rear.left | wheel.speed.RL | 0 (100 Hz) | angularvelocity.si | 0.0251327412 | 0 |
| 57 | channel.wheel.speed.rear.right | wheel.speed.RR | 0 (100 Hz) | angularvelocity.si | 0.0251327412 | 0 |
| 58 | channel.gyro.vehicle.yaw | gyro.yaw | 0 (100 Hz) | angularvelocity.si | 0.00041887902 | 0 |

> **Hybrid/EV channels:** The PDR 2.5 firmware includes channels for hybrid
> and electric powertrain components (e-motor power level, HV battery charge,
> e-motor temperatures, etc.). On the purely ICE CT5-V Blackwing, these channels
> are present in the data stream but read as zero.

### 2.2 adcp Box Structure

The `adcp` box contains channel parameter definitions:

```
Offset  Size  Field
0       2     header (u16 BE, observed: 0x0000)

Repeated for each channel:
  2     u16 BE    channel ID (0–58)
  var   string    null-terminated ASCII name (e.g., "com.cosworth.channel.speed")
  var   descriptor (see below)
```

**Numeric channel descriptor** (type byte = 0x01):
```
Offset  Size  Type    Field
0       2     u16 BE  unit_id (maps to adud unit definitions)
2       1     u8      type (0x01 = numeric)
3       1     u8      format/subtype indicator
4       8     f64 BE  scale factor (raw × scale → SI unit)
12      8     f64 BE  offset (added after scaling, in SI unit; Kelvin for temps)
20      var   ---     min/max raw value bounds (width matches data type)
```

**Enum channel descriptor** (type byte = 0x02):
```
Offset  Size  Type    Field
0       2     u16 BE  unit_id (typically 6 = none.none)
2       1     u8      type (0x02 = enum)
3       1     u8      format/subtype indicator (0x02 for u8 enum)
4       1     u8      num_subfields (always 1 observed)

For each subfield:
  var   string    null-terminated ASCII subfield name (e.g., "status", "current", "mode")
  1     u8        max_raw_value (domain range — largest defined value)
  var   string    null-terminated default/unknown label
  1     u8        default_value (raw value for the default state)
  1     u8        num_values (count of non-default entries)
  For each value:
    var   string  null-terminated ASCII label
    1     u8      raw value
```

See §2.4 for the complete decoded value-to-label mappings for all 9 enum channels.

### 2.3 Unit Definitions (`adud`)

The `adud` box maps unit IDs to Cosworth namespace names:

```
Offset  Size  Field
0       2     unit count (u16 BE)

Repeated for each unit:
  2     u16 BE    unit ID
  var   string    null-terminated ASCII name (e.g., "com.cosworth.unit.velocity.si")
```

Observed unit mappings:

| Unit ID | Cosworth Name | SI Unit |
|---------|--------------|---------|
| 0 | angle.si | radians |
| 1 | time.si | seconds |
| 2 | length.si | metres |
| 3 | temperature.si | Kelvin |
| 4 | velocity.si | m/s |
| 5 | pressure.si | Pascals |
| 6 | none.none | dimensionless |
| 7 | acceleration.si | m/s² |
| 8 | proportion.si | 0–1 ratio |
| 9 | angularvelocity.si | rad/s |
| 10 | torque.si | N·m |
| 11 | power.si | Watts |

### 2.4 Enum Channel Value-to-Label Mappings

All 9 enum channels have been fully decoded from the `adcp` binary descriptors.
Each enum channel stores a single `u8` raw value; the tables below give the
complete label for every defined value.

#### Ch 7 — ABS (Anti-Lock Braking System) — 10 Hz, subfield "status"

| Raw | Label |
|-----|-------|
| 0 | inactive |
| 1 | active |
| 3 | unknown (default) |

#### Ch 17 — Gear — 5 Hz, subfield "current"

| Raw | Label |
|-----|-------|
| 0 | notsupported (default) |
| 1 | first |
| 2 | second |
| 3 | third |
| 4 | fourth |
| 5 | fifth |
| 6 | sixth |
| 7 | seventh |
| 8 | eighth |
| 9 | ninth |
| 10 | tenth |
| 11 | unused |
| 12 | cvtforward |
| 13 | neutral |
| 14 | reverse |
| 15 | park |

> Gear values 1–10 cover up to a 10-speed automatic (CT5-V Blackwing uses a
> 10-speed 10L80). Values 13–15 are the non-drive gear positions (N/R/P).
> Value 12 ("cvtforward") is defined for CVT-equipped vehicles.

#### Ch 19 — Drive Performance Mode — 1 Hz, subfield "status"

| Raw | Label |
|-----|-------|
| 0 | none (default) |
| 1 | tour |
| 2 | sport |
| 3 | track |
| 4 | winter |
| 5 | offroad |
| 6 | towhaul |
| 7 | hold |
| 8 | mountain |
| 9 | personal |
| 10 | custom |
| 11 | awd |
| 12 | economy |
| 13 | automatic |
| 14 | ev |
| 15 | gradebraking |
| 16 | exhaustbrake |
| 17 | activerevmatch |
| 18 | 2wd |
| 19 | comfort |
| 20 | startstopdisable |
| 21 | crawl |
| 22 | chargeplus |
| 23 | baja |
| 24 | maxpower |

> This is a superset covering many GM platforms. The CT5-V Blackwing supports
> tour (1), sport (2), track (3), snow/ice (4), and My Mode / custom (10).
> Other values (offroad, towhaul, ev, baja, etc.) apply to trucks, SUVs, and
> hybrid/EV platforms sharing the PDR 2.5 firmware.

#### Ch 20 — E-Motor Axle Available — 1 Hz, subfield "status"

| Raw | Label |
|-----|-------|
| 0 | notavailable |
| 1 | available |
| 3 | unknown (default) |

> Always 0 ("notavailable") on purely ICE vehicles like the CT5-V Blackwing.

#### Ch 30 — Engine Start/Stop — 5 Hz, subfield "state"

| Raw | Label |
|-----|-------|
| 0 | engineoff |
| 1 | enginerunning |
| 2 | enginestarting |
| 3 | enginestopping |
| 7 | unknown (default) |

> Note: The firmware label string for value 0 contains a typo ("engineofff"
> with three f's); we normalise it to "engineoff" in the parser.

#### Ch 33 — ESC (Electronic Stability Control) — 5 Hz, subfield "status"

| Raw | Label |
|-----|-------|
| 0 | inactive |
| 1 | active |
| 3 | unknown (default) |

#### Ch 39 — PTM (Performance Traction Management) — 1 Hz, subfield "mode"

| Raw | Label |
|-----|-------|
| 0 | disabled |
| 1 | wet |
| 2 | dry |
| 3 | sport1 |
| 4 | sport2 |
| 5 | race |
| 6 | inactive |
| 7 | unknown (default) |

> PTM levels are specific to V-series vehicles. "sport1" through "race"
> correspond to decreasing levels of electronic intervention.

#### Ch 43 — TCS (Traction Control System) — 5 Hz, subfield "status"

| Raw | Label |
|-----|-------|
| 0 | inactive |
| 1 | active |
| 3 | unknown (default) |

#### Ch 53 — VSE (Vehicle Stability Enhancement) — 1 Hz, subfield "status"

| Raw | Label |
|-----|-------|
| 0 | active |
| 1 | inactive |
| 3 | unknown (default) |

> **Polarity note:** VSE uses the *opposite* polarity from ABS/ESC/TCS:
> 0 = active, 1 = inactive (vs 0 = inactive for ABS/ESC/TCS).

---

## 3. Rate Table (`adcr`)

### 3.1 Header

```
Offset  Size  Field
0       1     version (1 in PDR 2.5 files)
1       1     flags
2       1     num_groups (6)
3       1     padding
```

### 3.2 Per-Group Structure

For each of `num_groups` groups:

```
Offset  Size  Field
0       3-4   padding bytes (3 for first group, 4 for subsequent groups)
3/4     4     period (big-endian u32, in 100 ns ticks)
7/8     2     num_channels (big-endian u16)
9/10    N×3   channel entries: ch_id (u16 BE) + width (u8)
```

> **Note:** In version 1 of the `adcr` format, the first group uses 3 padding
> bytes before the period field, but all subsequent groups use 4 padding bytes.
> Parsers must account for this asymmetry.

### 3.3 Rate Groups

**Legacy format** (MMP ≤ 3 / gen 1):

| Group | Period (100 ns ticks) | Frequency | Channels | Rate-Table Width | Actual Width |
|-------|----------------------|-----------|----------|-----------------|--------------|
| 0 | 100,000 | 100 Hz | 9 | 32 bytes | **17 bytes** |
| 1 | 200,000 | 50 Hz | 6 | 54 bytes | **24 bytes** |
| 2 | 1,000,000 | 10 Hz | 12 | 44 bytes | **28 bytes** |
| 3 | 2,000,000 | 5 Hz | 4 | 8 bytes | **4 bytes** |
| 4 | 5,000,000 | 2 Hz | 1 | 2 bytes | **1 byte** |
| 5 | 10,000,000 | 1 Hz | 27 | 59 bytes | **31 bytes** |

**MMP v4+ format** (gen 2 MMP ≥ 4) — Groups 0 and 5 change:

| Group | Frequency | Actual Width | Change |
|-------|-----------|-------------|--------|
| 0 | 100 Hz | **25 bytes** | wheel speed channels widen from u16 (2 bytes) to float32 (4 bytes), +8 bytes |
| 5 | 1 Hz | **34 bytes** | drive.performance.mode widens from u8 (1 byte) to u32 (4 bytes), +3 bytes |

Groups 1–4 are unchanged between format versions.

> **Critical finding:** The `width` values in the rate table do NOT represent
> the actual byte count stored in the data stream. Each channel's rate-table
> width includes metadata overhead bytes (quality/validity descriptors) that are
> not written to the data. The overhead varies by data type:
>
> | Data Type | Rate-Table Width | Actual Bytes | Overhead |
> |-----------|-----------------|-------------|----------|
> | u8 status/enum channels | 2 | 1 | 1 |
> | u8 emotor.powerlevel (ch 15) | 1 | 1 | 0 |
> | u16 numeric channels | 4 | 2 | 2 |
> | i16 signed (steering, gyro) | 3 | 2 | 1 |
> | i32 GPS coordinates/heading | 5 | 4 | 1 |
> | u32 odometer | 6 | 4 | 2 |
> | float32 (accelerometer) | 9 | 4 | 5 |

### 3.4 Group 0 Channels (100 Hz)

**Legacy format (17 bytes):**

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 16 | brake.position | 2 | 1 |
| 29 | engine.speed | 4 | 2 |
| 31 | engine.torque | 4 | 2 |
| 42 | steering.angle | 3 | 2 |
| 54 | wheel.speed.FL | 4 | 2 (u16) |
| 55 | wheel.speed.FR | 4 | 2 (u16) |
| 56 | wheel.speed.RL | 4 | 2 (u16) |
| 57 | wheel.speed.RR | 4 | 2 (u16) |
| 58 | gyro.yaw | 3 | 2 |

**MMP v4+ format (25 bytes):** Wheel speed channels change from u16 (2 bytes)
to float32 (4 bytes each), adding 8 bytes total:

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 16 | brake.position | 2 | 1 |
| 29 | engine.speed | 4 | 2 |
| 31 | engine.torque | 4 | 2 |
| 42 | steering.angle | 3 | 2 |
| 54 | wheel.speed.FL | **9** | **4 (float32)** |
| 55 | wheel.speed.FR | **9** | **4 (float32)** |
| 56 | wheel.speed.RL | **9** | **4 (float32)** |
| 57 | wheel.speed.RR | **9** | **4 (float32)** |
| 58 | gyro.yaw | 3 | 2 |

> The `adcr` rate table encodes this difference: wheel speed channels have
> width byte 0x04 (u16) in legacy files vs 0x09 (float32) in MMP v4+ files.
> This can be used to detect the format variant from the adcr box alone.

### 3.5 Group 1 Channels (50 Hz, 24 bytes actual)

Six channels, each stored as an IEEE 754 big-endian float32 (4 bytes):

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 8 | accel.device.x | 9 | 4 |
| 9 | accel.device.y | 9 | 4 |
| 10 | accel.device.z | 9 | 4 |
| 11 | accel.vehicle.x | 9 | 4 |
| 12 | accel.vehicle.y | 9 | 4 |
| 13 | accel.vehicle.z | 9 | 4 |

### 3.6 Group 2 Channels (10 Hz, 28 bytes actual)

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 0 | speed | 4 | 2 |
| 1 | gps.latitude | 5 | 4 |
| 2 | gps.longitude | 5 | 4 |
| 3 | gps.altitude | 5 | 4 |
| 4 | gps.heading | 5 | 4 |
| 5 | gps.fixquality | 2 | 1 |
| 6 | gps.satellites | 2 | 1 |
| 7 | ABS.status | 2 | 1 |
| 14 | throttle.position | 2 | 1 |
| 24 | boost.pressure | 4 | 2 |
| 40 | emotor.power | 4 | 2 |
| 41 | engine.power | 4 | 2 |

### 3.7 Group 3 Channels (5 Hz, 4 bytes actual)

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 17 | gear | 2 | 1 |
| 30 | engine.startstop | 2 | 1 |
| 33 | ESC.status | 2 | 1 |
| 43 | TCS.status | 2 | 1 |

### 3.8 Group 4 Channel (2 Hz, 1 byte actual)

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 26 | oil.pressure | 2 | 1 |

### 3.9 Group 5 Channels (1 Hz, 31 or 34 bytes actual)

27 channels packed into 31 bytes (legacy) or 34 bytes (MMP v4+). Full
byte-level mapping in §11.

In MMP v4+, ch 19 (drive.performance.mode) widens from u8 (1 byte, rateW=2)
to u32 (4 bytes, rateW=6), adding 3 bytes and shifting all subsequent channels.

| Ch | Name | Rate-Table Width | Actual Bytes (legacy) | Actual Bytes (MMP v4+) |
|----|------|-----------------|----------------------|----------------------|
| 15 | emotor.powerlevel | 1 | 1 | 1 |
| 18 | HV.battery.usablecharge | 4 | 2 | 2 |
| 19 | drive.performance.mode | 2 / **6** | 1 (u8) | **4 (u32)** |
| 20 | emotor.axle.available | 2 | 1 | 1 |
| 21 | emotor.temp.rotor | 2 | 1 |
| 22 | emotor.temp.stator | 2 | 1 |
| 23 | engine.temp.coolant | 2 | 1 |
| 25 | engine.temp.airintake | 2 | 1 |
| 27 | engine.temp.oil | 2 | 1 |
| 28 | engine.powerlevel | 2 | 1 |
| 32 | outside.air.temp | 2 | 1 |
| 34 | fuel.level | 2 | 1 |
| 35 | HV.battery.temp.avg | 2 | 1 |
| 36 | HV.battery.temp.max | 2 | 1 |
| 37 | HV.battery.temp.min | 2 | 1 |
| 38 | odometer.distance | 6 | 4 |
| 39 | PTM.mode | 2 | 1 |
| 44 | trans.oil.temp | 2 | 1 |
| 45 | tire.pressure.FL | 2 | 1 |
| 46 | tire.pressure.FR | 2 | 1 |
| 47 | tire.pressure.RL | 2 | 1 |
| 48 | tire.pressure.RR | 2 | 1 |
| 49 | tire.temp.FL | 2 | 1 |
| 50 | tire.temp.FR | 2 | 1 |
| 51 | tire.temp.RL | 2 | 1 |
| 52 | tire.temp.RR | 2 | 1 |
| 53 | VSE.status | 2 | 1 |

---

## 4. Packet Structure

### 4.1 Sample Table

The data track's sample table (`stsz`) typically contains:

- 1–2 init samples of 14 bytes
- ~400–660 data samples at a uniform size (some slightly larger due to embedded events)

The dominant data sample size indicates the format variant:
- **3247 bytes** — legacy format (MMP ≤ 3 / gen 1)
- **4050 bytes** — MMP v4+ format

Each data sample represents **1 second** of telemetry.

### 4.2 Init Packet (14 bytes)

The first sample is a 14-byte initialisation packet containing a format version
and timing reference for the recording session.

### 4.3 Data Packet (3247 or 4050 bytes, nominal)

Each data packet contains 1 second of time-interleaved multi-rate data
organised into **10 frames** (one per 100 ms GPS epoch). The packet size
depends on the format variant (see §3.3).

### 4.4 Frame Interleaving Pattern

Within each 1-second packet, data is interleaved as follows. The pattern
repeats 10 times (once per 10 Hz GPS reading):

```
For frame_idx in 0..9:

  [Group 2: 10 Hz base]           28 bytes (GPS/vehicle)
  [Group 3: 5 Hz, if even frame]   4 bytes (frames 0, 2, 4, 6, 8)
  [Group 4: 2 Hz, if frame 0 or 5] 1 byte
  [Group 5: 1 Hz, if frame 0]     31 bytes (legacy) / 34 bytes (MMP v4+)

  Repeated 5 times:
    [Group 0: 100 Hz sub-frame]   17 bytes (legacy) / 25 bytes (MMP v4+)
    [Group 0: 100 Hz sub-frame]   17 bytes (legacy) / 25 bytes (MMP v4+)
    [Group 1: 50 Hz sub-frame]    24 bytes
```

This gives 10 × 100 Hz readings per frame (10 frames × 10 = 100 per second),
10 × 5 = 50 Hz readings per frame, and the base 10 Hz / 5 Hz / 2 Hz / 1 Hz
at their respective rates.

### 4.5 Preamble Structure (14 bytes)

Each data packet begins with a 14-byte preamble before the first 10 Hz frame:

```
Offset  Size  Type    Field
0       4     u32     zero padding (always 0x00000000)
4       4     u32 BE  timestamp (100 ns ticks from recording start)
8       1     u8      flags (observed: 0x01)
9       3     ---     zero padding
12      2     u16 BE  format identifier (observed: 0x0CA1)
```

The timestamp at offset 4 increments by exactly 10,000,000 per packet
(= 1.0 second at 100 ns resolution), confirming the one-second-per-packet
timing model.

After the 14-byte preamble, the remaining bytes before the first GPS latitude
position (~41 bytes) contain leftover 100 Hz sub-frame data carried over from
the previous second's timing boundary. This gives a total preamble region of
~55 bytes before the first 10 Hz frame begins.

### 4.6 Byte Budget Verification

**Legacy format** (3247 bytes):
```
Preamble:      14 bytes (header + partial sub-frames)
10 Hz base:   10 × 28  = 280
5 Hz data:     5 × 4   =  20
2 Hz data:     2 × 1   =   2
1 Hz data:     1 × 31  =  31
100 Hz frames: 100 × 17 = 1700
50 Hz frames:  50 × 24  = 1200
                         ------
Total:                    3247
```

**MMP v4+ format** (4050 bytes):
```
Preamble:      14 bytes (header + partial sub-frames)
10 Hz base:   10 × 28  = 280
5 Hz data:     5 × 4   =  20
2 Hz data:     2 × 1   =   2
1 Hz data:     1 × 34  =  34
100 Hz frames: 100 × 25 = 2500
50 Hz frames:  50 × 24  = 1200
                         ------
Total:                    4050
```

### 4.7 GPS Offset Within Packets

The first GPS latitude position occurs at a consistent offset of approximately
**57 bytes** from the packet start (14-byte header + ~41 bytes of carried-over
sub-frame data + 2 bytes of speed). Subsequent GPS positions are spaced at
regular intervals determined by the interleaving pattern (~290-320 bytes apart).

To locate GPS data, scan for the byte pattern of a known latitude in the
expected range (e.g., `0x15 0x8F xxxx` for ~36° N), then validate with
longitude, altitude, and clustering checks.

---

## 5. Scale Factors and Encoding

All multi-byte integers are **big-endian**. The general conversion formula for
numeric channels is:

```
SI_value = raw × scale + offset
```

Where `scale` and `offset` come from the `adcp` descriptor for each channel.

### 5.1 GPS Coordinate Encoding

GPS coordinates are stored as 32-bit signed integers representing a value in
a radians-derived unit:

```
degrees = raw_i32 × 1.7453293e-09 × (180 / π)
```

The constant `1.7453293e-09` converts from the raw integer domain to radians,
and `180/π` converts radians to degrees. The combined scale is approximately
`1.0e-07` degrees per raw unit, giving ~1 cm resolution.

### 5.2 GPS Heading Encoding

Heading is stored as a 32-bit signed integer with a coarser scale than
coordinates:

```
heading_deg = raw_i32 × 1.745329252e-07 × (180 / π)
```

The heading scale is exactly 100× the lat/lon scale, giving ~0.001° resolution
(adequate for vehicle heading). Range covers 0–360° with signed representation.

### 5.3 Speed Encoding

```
speed_mps = raw_u16 × 0.00434028
speed_kph = speed_mps × 3.6
speed_mph = speed_mps × 2.23694
```

### 5.4 Engine Speed Encoding

```
speed_rad_s = raw_u16 × 0.0261799388
speed_rpm   = speed_rad_s × 60 / (2π) ≈ raw_u16 × 0.25
```

### 5.5 Steering / Heading Angle Encoding (100 Hz steering)

```
angle_rad = raw_i16 × 0.001090831
angle_deg = angle_rad × (180 / π)
```

### 5.6 Wheel Speed Encoding

**Legacy format (u16 angular velocity):**

Wheel speeds use a **slightly different angular velocity scale** from engine
speed:

```
wheel_rad_s = raw_u16 × 0.0251327412
wheel_rpm   = wheel_rad_s × 60 / (2π) ≈ raw_u16 × 0.24
```

Note: wheel speed scale (2π/250) differs from engine speed scale (2π/240) by
~4%. To convert to vehicle speed, multiply by the effective tire rolling radius.
For a CT5-V Blackwing with 245/35R19 tires (nominal radius ~0.337 m):

```
speed_mps = wheel_rad_s × tire_radius
```

A best-fit effective radius of ~0.321 m (vs 0.337 m nominal) gives
GPS-matching speeds. The ~5% difference is due to tire compression under load.

**MMP v4+ format (float32 m/s):**

Wheel speeds are stored directly as IEEE 754 big-endian float32 values in
metres per second — no angular velocity conversion or tire radius needed:

```
speed_mps = raw_float32     (direct value)
speed_kph = raw_float32 × 3.6
```

### 5.7 Engine Torque Encoding

Engine torque is stored as u16 with a confirmed scale and offset from the
`adcp` descriptor:

```
torque_Nm = raw_u16 × 0.5 - 848.0
```

| Parameter | Value |
|-----------|-------|
| Scale | 0.5 N·m per raw unit |
| Offset | -848.0 N·m |
| Zero torque | raw = 1696 |
| Raw range | 0–4095 (12 bits used) |
| Torque range | -848 to +1199.5 N·m |
| Peak observed | raw 3153 → 728.5 N·m (80% of rated 905 N·m) |

At idle, raw values cluster around 1700–1800 (small positive torque to maintain
RPM). Under moderate acceleration values rise toward 2500+. A full wide-open-
throttle recording would be needed to observe the rated 905 N·m peak.

### 5.8 Temperature Encoding

All temperature channels use the same pattern: raw value is scaled then offset
by a Kelvin constant to produce Kelvin, which is converted to Celsius:

```
temp_K = raw × scale + kelvin_offset
temp_C = temp_K - 273.15
```

Two Kelvin offsets are used:

| Offset | Channels | Simplified Formula |
|--------|----------|-------------------|
| 233.15 K | Engine temps, transmission, outside air, HV battery, e-motor | raw × scale - 40 |
| 253.15 K | Tire temperatures | raw × scale - 20 |

For scale = 1.0 (most engine temps): `temp_C = raw - 40`
For scale = 0.5 (outside air, HV battery max/min): `temp_C = raw × 0.5 - 40`
For tire temps (scale = 1.0, offset 253.15): `temp_C = raw - 20`

### 5.9 Pressure Encoding

```
oil_pressure_Pa   = raw_u8 × 4000
boost_pressure_Pa = raw_u16 × 1000
tire_pressure_Pa  = raw_u8 × 4000
```

### 5.10 Proportion Encoding

Throttle position, brake position, and fuel level use raw-to-proportion scales:

```
throttle_pct = raw_u8 × 0.00392157    (= 1/255, so 0–255 maps to 0.0–1.0)
brake_pct    = raw_u8 × 0.00392157
fuel_pct     = raw_u8 × 0.003921      (≈ 1/255)
```

### 5.11 Power Encoding

```
emotor_power_W = raw_u16 × 500
engine_power_W = raw_u16 × 500
```

### 5.12 Accelerometer Encoding

The six accelerometer channels are stored as IEEE 754 float32 values in **g**
units. The `adcp` scale of 9.80665 converts to SI units (m/s²):

```
accel_g   = raw_float32          (direct value in g)
accel_mps2 = raw_float32 × 9.80665
```

### 5.13 Gyro Yaw Rate Encoding

```
yaw_rad_s = raw_i16 × 0.00041887902
yaw_deg_s = yaw_rad_s × (180 / π)
```

---

## 6. 100 Hz Sub-Frame Layout

### 6.1 Legacy Format (17 bytes)

```
Offset  Size  Type    Channel             Encoding
0       1     u8      brake.position      × 0.00392157 → proportion (0–1)
1       2     u16 BE  engine.speed        × 0.0261799388 rad/s → RPM
3       2     u16 BE  engine.torque       × 0.5 - 848 → N·m
5       2     i16 BE  steering.angle      × 0.001090831 rad → degrees
7       2     u16 BE  wheel.speed.FL      × 0.0251327412 rad/s
9       2     u16 BE  wheel.speed.FR      × 0.0251327412 rad/s
11      2     u16 BE  wheel.speed.RL      × 0.0251327412 rad/s
13      2     u16 BE  wheel.speed.RR      × 0.0251327412 rad/s
15      2     i16 BE  gyro.yaw            × 0.00041887902 rad/s
```

### 6.2 MMP v4+ Format (25 bytes)

The first 7 bytes (brake, engine speed, torque, steering) are identical. Wheel
speeds change from u16 angular velocity to float32 m/s, and gyro moves to
offset 23:

```
Offset  Size  Type       Channel             Encoding
0       1     u8         brake.position      × 0.00392157 → proportion (0–1)
1       2     u16 BE     engine.speed        × 0.0261799388 rad/s → RPM
3       2     u16 BE     engine.torque       × 0.5 - 848 → N·m
5       2     i16 BE     steering.angle      × 0.001090831 rad → degrees
7       4     float32 BE wheel.speed.FL      direct m/s → × 3.6 for kph
11      4     float32 BE wheel.speed.FR      direct m/s → × 3.6 for kph
15      4     float32 BE wheel.speed.RL      direct m/s → × 3.6 for kph
19      4     float32 BE wheel.speed.RR      direct m/s → × 3.6 for kph
23      2     i16 BE     gyro.yaw            × 0.00041887902 rad/s
```

> **Parser note:** In MMP v4+ packets, the float32 wheel speed values at low
> vehicle speeds (< 5 kph, values near zero) can create false matches in the
> 50 Hz float block scanner, since near-zero floats look like valid IEEE 754
> values. Decoded 100 Hz frames should be validated: reject any frame with
> RPM > 12,000 or any wheel speed > 400 kph.

---

## 7. 50 Hz Sub-Frame Layout (24 bytes)

Six IEEE 754 big-endian float32 values from two independent 3-axis
accelerometers:

```
Offset  Size  Type      Channel               Rest Value
0       4     float32   accel.device.x         ~+0.628 g
4       4     float32   accel.device.y         ~-0.777 g
8       4     float32   accel.device.z         ~+0.011 g
12      4     float32   accel.vehicle.x        ~-0.048 g
16      4     float32   accel.vehicle.y        ~+0.039 g
20      4     float32   accel.vehicle.z        ~+0.996 g
```

### 7.1 Dual Accelerometer Interpretation

The six channels represent two independent 3-axis readings:

- **Device** (ch 8–10, offsets 0/4/8): Raw/unrotated sensor output. At rest,
  the vector magnitude is 1.00 g, but the gravity vector projects onto all
  three axes because the sensor is physically **mounted at ~17° tilt** from
  the vehicle vertical.

- **Vehicle** (ch 11–13, offsets 12/16/20): Gravity-compensated /
  vehicle-frame-aligned reading. At rest, z ≈ 1.0 g with near-zero x and y,
  indicating coordinate rotation has been applied.

Both sets produce vector magnitudes of ~1.00 g at rest.

> **Axis mapping note:** The device x/y channels correspond to the vehicle's
> lateral/longitudinal axes (pre-rotation). The vehicle x/y/z channels are
> aligned to vehicle-frame lateral/longitudinal/vertical.

---

## 8. 10 Hz Frame Layout (28 bytes)

```
Offset  Size  Type    Channel             Encoding
0       2     u16 BE  speed               × 0.00434028 → m/s
2       4     i32 BE  gps.latitude        × 1.7453293e-9 rad → degrees
6       4     i32 BE  gps.longitude       × 1.7453293e-9 rad → degrees
10      4     i32 BE  gps.altitude        × 0.001 → metres
14      4     i32 BE  gps.heading         × 1.745329252e-7 rad → degrees
18      1     u8      gps.fixquality      3 = PPS fix
19      1     u8      gps.satellites      count (typically 12–16)
20      1     u8      ABS.status          enum (see §2.4: 0=inactive, 1=active)
21      1     u8      throttle.position   × 0.00392157 → proportion (0–1)
22      2     u16 BE  boost.pressure      × 1000 → Pa
24      2     u16 BE  emotor.power        × 500 → W (0 on ICE vehicles)
26      2     u16 BE  engine.power        × 500 → W
```

> **Key correction from `adcp`:** The heading field is 4 bytes (i32), not 2.
> What was previously identified as a 2-byte "internal counter" was the lower
> 16 bits of the heading value. The fields after heading are ABS status and
> throttle position (1 byte each), not engine coolant temperature (2 bytes).
> And boost pressure replaces what was previously identified as tire pressure.

---

## 9. 5 Hz Frame Layout (4 bytes)

Present in even-numbered 10 Hz frames (indices 0, 2, 4, 6, 8).

```
Offset  Size  Type  Channel           Encoding
0       1     u8    gear              enum (see §2.4: 1–10=first–tenth, 13=neutral, 14=reverse, 15=park)
1       1     u8    engine.startstop  enum (see §2.4: 0=off, 1=running, 2=starting, 3=stopping)
2       1     u8    ESC.status        enum (see §2.4: 0=inactive, 1=active)
3       1     u8    TCS.status        enum (see §2.4: 0=inactive, 1=active)
```

---

## 10. 2 Hz Frame Layout (1 byte)

Present in 10 Hz frames 0 and 5.

```
Offset  Size  Type  Channel        Encoding
0       1     u8    oil.pressure   × 4000 → Pa
```

---

## 11. 1 Hz Frame Layout

Present only in 10 Hz frame 0. Contains 27 channels with engine temperatures,
tire data, odometer, and other slowly-changing vehicle parameters. Full mapping
confirmed via `adcp` channel order cross-referenced with observed data patterns.

### 11.0 Legacy Format (31 bytes)

```
Offset  Size  Type    Ch  Channel                     Encoding
0       1     u8      15  emotor.powerlevel           × 0.01 → proportion
1       2     u16 BE  18  HV.battery.usablecharge     × 1.5259e-5 → proportion
3       1     u8      19  drive.performance.mode      enum (see §2.4: 10=custom observed on CT5-V BW)
4       1     u8      20  emotor.axle.available       enum (see §2.4: 0=notavailable on ICE)
5       1     u8      21  emotor.temp.rotor           raw - 40 → °C (0 on ICE)
6       1     u8      22  emotor.temp.stator          raw - 40 → °C (0 on ICE)
7       1     u8      23  engine.temp.coolant         raw - 40 → °C
8       1     u8      25  engine.temp.airintake       raw - 40 → °C
9       1     u8      27  engine.temp.oil             raw - 40 → °C
10      1     u8      28  engine.powerlevel           × 0.01 → proportion
11      1     u8      32  outside.air.temp            raw × 0.5 - 40 → °C
12      1     u8      34  fuel.level                  × 0.003921 → proportion
13      1     u8      35  HV.battery.temp.avg         raw - 40 → °C (0 on ICE)
14      1     u8      36  HV.battery.temp.max         raw × 0.5 - 40 → °C
15      1     u8      37  HV.battery.temp.min         raw × 0.5 - 40 → °C
16      4     u32 BE  38  odometer.distance           × 15.625 → metres
20      1     u8      39  PTM.mode                    enum (see §2.4: 3=sport1 observed)
21      1     u8      44  trans.oil.temp              raw - 40 → °C
22      1     u8      45  tire.pressure.FL            × 4000 → Pa
23      1     u8      46  tire.pressure.FR            × 4000 → Pa
24      1     u8      47  tire.pressure.RL            × 4000 → Pa
25      1     u8      48  tire.pressure.RR            × 4000 → Pa
26      1     u8      49  tire.temp.FL                raw - 20 → °C
27      1     u8      50  tire.temp.FR                raw - 20 → °C
28      1     u8      51  tire.temp.RL                raw - 20 → °C
29      1     u8      52  tire.temp.RR                raw - 20 → °C
30      1     u8      53  VSE.status                  enum (see §2.4: 0=active, 1=inactive — opposite polarity!)
```

### 11.0b MMP v4+ Format (34 bytes)

In MMP v4+, ch 19 (`drive.performance.mode`) widens from u8 (1 byte) to u32
(4 bytes), adding 3 bytes and shifting all subsequent channel offsets by +3.
Only the low byte of the u32 is used for the enum value lookup:

```
Offset  Size  Type    Ch  Channel                     Encoding
0       1     u8      15  emotor.powerlevel           × 0.01 → proportion
1       2     u16 BE  18  HV.battery.usablecharge     × 1.5259e-5 → proportion
3       4     u32 BE  19  drive.performance.mode      low byte → enum (see §2.4)
7       1     u8      20  emotor.axle.available       enum
8       1     u8      21  emotor.temp.rotor           raw - 40 → °C
9       1     u8      22  emotor.temp.stator          raw - 40 → °C
10      1     u8      23  engine.temp.coolant         raw - 40 → °C
11      1     u8      25  engine.temp.airintake       raw - 40 → °C
12      1     u8      27  engine.temp.oil             raw - 40 → °C
13      1     u8      28  engine.powerlevel           × 0.01 → proportion
14      1     u8      32  outside.air.temp            raw × 0.5 - 40 → °C
15      1     u8      34  fuel.level                  × 0.003921 → proportion
16      1     u8      35  HV.battery.temp.avg         raw - 40 → °C
17      1     u8      36  HV.battery.temp.max         raw × 0.5 - 40 → °C
18      1     u8      37  HV.battery.temp.min         raw × 0.5 - 40 → °C
19      4     u32 BE  38  odometer.distance           × 15.625 → metres
23      1     u8      39  PTM.mode                    enum (see §2.4)
24      1     u8      44  trans.oil.temp              raw - 40 → °C
25      1     u8      45  tire.pressure.FL            × 4000 → Pa
26      1     u8      46  tire.pressure.FR            × 4000 → Pa
27      1     u8      47  tire.pressure.RL            × 4000 → Pa
28      1     u8      48  tire.pressure.RR            × 4000 → Pa
29      1     u8      49  tire.temp.FL                raw - 20 → °C
30      1     u8      50  tire.temp.FR                raw - 20 → °C
31      1     u8      51  tire.temp.RL                raw - 20 → °C
32      1     u8      52  tire.temp.RR                raw - 20 → °C
33      1     u8      53  VSE.status                  enum (see §2.4)
```

### 11.1 Observed Value Ranges (CT5-V Blackwing, ~11 min recording)

| Offset | Channel | Raw Range | Physical Range |
|--------|---------|-----------|---------------|
| 7 | engine.temp.coolant | 121–145 | 81–105 °C |
| 8 | engine.temp.airintake | 78–98 | 38–58 °C |
| 9 | engine.temp.oil | 116–181 | 76–141 °C |
| 11 | outside.air.temp | 135–140 | 27.5–30.0 °C |
| 12 | fuel.level | 170–184 | 66.6–72.1 % |
| 16–19 | odometer | ~293,000 | ~4,578 km |
| 21 | trans.oil.temp | 106–112 | 66–72 °C |
| 22–25 | tire.pressure.* | ~56–62 | 224–248 kPa |
| 26–29 | tire.temp.* | ~40–55 | 20–35 °C |

---

## 12. Extraction Methods

### 12.1 Via ffmpeg

```bash
ffmpeg -v quiet -i input.mp4 -map 0:1 -c copy -f data telemetry_raw.bin
```

This extracts the raw data track. The resulting file contains a 14-byte init
packet followed by uniform-sized data packets (3247 bytes for legacy format,
4050 bytes for MMP v4+).

### 12.2 Direct MP4 Parsing

1. Navigate to `moov` box
2. Iterate `trak` boxes; for each, recursively find `hdlr` and check for
   `handler_type == "adrv"`, or find `stsd` and check for `adco` codec tag
3. Parse the sample table (`stsz`, `stco`/`co64`, `stsc`) to get sample
   offsets and sizes
4. Read each sample directly from the file at its absolute offset

### 12.3 Locating `adcp`/`adcr`/`adud` Sub-Boxes

The `adcp`, `adcr`, and `adud` boxes are nested inside the `adco` sample
description entry within `stsd`. To locate them:

1. **Structured approach:** Navigate `moov/trak/mdia/minf/stbl/stsd`, parse
   the `adco` entry, then iterate its child boxes.

2. **Brute-force approach:** Scan the entire MP4 file for the 4-byte magic
   bytes (`adcp`, `adcr`, `adud`). For each match, read the 4 bytes preceding
   it as a big-endian u32 box size and validate (8 < size < 100000). This
   approach works reliably since these box names do not collide with data
   content.

---

## 13. Outing Properties (`adop`)

The `adop` box contains metadata about the recording session, stored as
key-value pairs. Known properties include:

- Vehicle model identifier (e.g., "A2LL" for Cadillac CT5)
- VIN
- Track/venue name
- GPS bounding box (min/max lat/lon as float64)
- Recording start timestamp
- Firmware version

GPS bounding-box coordinates are stored as big-endian IEEE 754 float64 (double)
values in degrees and can be used as a reference location for GPS search within
data packets.

---

## 14. Version Info (`advi`)

The `advi` box (64 bytes) contains format version information, hardware/firmware
identifiers, and a Cosworth namespace source identifier string.

### 14.1 Structure

```
Offset  Size  Type    Field
0       4     u32 BE  box size (64)
4       4     ascii   box type ("advi")
8       2     u16 BE  format_version (5 = PDR 2.5)
10      2     u16 BE  reserved (0)
12      2     u16 BE  generation — hardware generation (1 = gen 1, 2 = gen 2)
14      2     u16 BE  mmp_version — MMP firmware version (see §14.2)
16      2     u16 BE  field_3 (observed: 110)
18      2     u16 BE  field_4 (observed: 30)
20      4     u32 BE  field_5 (observed: 384063)
24      2     u16 BE  field_6 (observed: 1)
26      2     u16 BE  field_7 (observed: 17)
28      2     u16 BE  field_8 (observed: 80)
30      var   string  null-terminated source identifier
```

The source identifier string is `"com.cosworth.outing.source.pdr2_5"`,
which identifies the data format as AliveDrive PDR 2.5.

### 14.2 Generation and MMP Version

The `generation` field at offset 12 identifies the hardware generation, and the
`mmp_version` field at offset 14 identifies the MMP firmware version. Together
they determine the data format variant:

| Generation | MMP Version | Packet Size | Format |
|------------|-------------|-------------|--------|
| 1 | 8 | 3247 | Legacy (17-byte 100 Hz) |
| 2 | 3 | 3247 | Legacy (17-byte 100 Hz) |
| 2 | 4+ | 4050 | MMP v4+ (25-byte 100 Hz) |

> **Important:** MMP version numbering differs across hardware generations.
> Gen 1 devices report MMP version 8 but use the legacy 3247-byte packet format.
> The MMP version alone is **not** a reliable indicator of the data format.
> Use the dominant packet size from the sample table (`stsz`) instead:
> sizes > 3500 indicate MMP v4+ format. See §4.1.

---

## 15. Event Definitions (`adeg`)

The `adeg` box (950 bytes) defines the performance timing events that the PDR
system can trigger during a recording session. Each event has a numeric ID and
a Cosworth namespace name.

### 15.1 Structure

```
Offset  Size  Type    Field
0       4     u32 BE  box size
4       4     ascii   box type ("adeg")

Repeated for each event:
  2     u16 BE    event ID (0–19)
  var   string    null-terminated ASCII event name
```

### 15.2 Event Table

Events come in start/end pairs, defining 10 performance timing categories:

| ID | Cosworth Name | Category |
|----|--------------|----------|
| 0 | event.lap.start | Lap timing |
| 1 | event.lap.end | Lap timing |
| 2 | event.performance.0-60mph.start | 0–60 mph |
| 3 | event.performance.0-60mph.end | 0–60 mph |
| 4 | event.performance.0-100mph.start | 0–100 mph |
| 5 | event.performance.0-100mph.end | 0–100 mph |
| 6 | event.performance.0-100-0mph.start | 0–100–0 mph |
| 7 | event.performance.0-100-0mph.end | 0–100–0 mph |
| 8 | event.performance.standingquartermi.start | Standing ¼ mi |
| 9 | event.performance.standingquartermi.end | Standing ¼ mi |
| 10 | event.performance.0-96kph.start | 0–96 kph |
| 11 | event.performance.0-96kph.end | 0–96 kph |
| 12 | event.performance.0-160kph.start | 0–160 kph |
| 13 | event.performance.0-160kph.end | 0–160 kph |
| 14 | event.performance.0-160-0kph.start | 0–160–0 kph |
| 15 | event.performance.0-160-0kph.end | 0–160–0 kph |
| 16 | event.performance.standing402m.start | Standing 402 m |
| 17 | event.performance.standing402m.end | Standing 402 m |
| 18 | event.performance.customtimer.start | Custom timer |
| 19 | event.performance.customtimer.end | Custom timer |

> All event names use the `com.cosworth.` prefix (omitted in the table above
> for brevity). Events 0–9 are imperial-unit performance tests; events 10–17
> are their metric equivalents. The standing ¼ mile (events 8–9) and standing
> 402 m (events 16–17) are the same physical test expressed in different units.
> Events 18–19 provide a user-configurable custom timer.

### 15.3 Embedded Event Records in Telemetry Packets

When events fire during a 1-second telemetry packet, the firmware appends
event records to the end of the packet, making it larger than the nominal
size (see §4.1). Each event record is **11 bytes**:

```
Offset  Size  Type      Field
0       8     u64 BE    timestamp (100 ns ticks from recording start)
8       2     u16 BE    flags (observed: 0x0200)
10      1     u8        event_id (0–19, maps to adeg definitions)
```

Multiple events can be embedded in a single packet. The extra bytes at the
end of an oversized packet are always a multiple of 11. The timestamp uses
the same 100 ns tick resolution as the packet preamble timestamp (§4.5).

**Example**: A packet of size 3258 (nominal 3247 + 11) contains one event.
A packet of size 3269 (nominal + 22) contains two events. A packet of size
3346 (nominal + 99) contains nine events (typically all performance timer
start events firing simultaneously when the car first crosses S/F).

**Lap timing events**: Event ID 0 (`event.lap.start`) fires at each S/F
line crossing, as defined by the driver-set start/finish marker in the
vehicle's PDR settings. Event ID 1 (`event.lap.end`) fires simultaneously
with the next `event.lap.start`, marking the end of one lap and the start
of the next. Lap times are computed from consecutive `event.lap.start`
timestamps (start-to-start timing).

> The driver configures the S/F line position through the vehicle's
> infotainment PDR interface. The MMP firmware then triggers
> `event.lap.start` / `event.lap.end` at the configured GPS crossing point.
> This is more accurate than GPS density heuristics since it uses the exact
> position the driver intended as the timing reference.

---

## 16. Comparison with Older Marlin Format

| Feature | AliveDrive PDR 2.5 | Marlin (C7/C8 Corvette) |
|---------|-------------------|------------------------|
| Handler type | `adrv` | `ctbx` |
| Codec tag | `adco` | `mrld` / `mrlv` / `marl` |
| Data layout | Time-interleaved | Planar (one channel per block) |
| GPS encoding | Radians-derived i32 | Direct float or fixed-point |
| Accelerometer | IEEE 754 float32 | Fixed-point integer |
| Rate groups | 6 (100/50/10/5/2/1 Hz) | Varies |
| Sub-boxes | advi/adop/adcp/adcr/adud/adeg | Different structure |

---

## 17. Open Questions

1. ~~**Enum value mappings**~~: **Resolved.** All 9 enum channels have been
   fully decoded from the `adcp` binary descriptors. See §2.4 for the
   complete value-to-label tables covering gear (16 values including P/R/N
   and 10-speed gears), drive mode (25 values covering multiple GM
   platforms), PTM (8 modes), ABS/ESC/TCS/VSE status, engine start/stop
   state, and e-motor axle availability.

2. **10 Hz heading validation**: The heading field has been corrected from
   u16 (2 bytes) to i32 (4 bytes) based on `adcp` evidence (rateW=5, same
   as lat/lon/altitude). The new scale (1.745329252e-7 rad) should be
   validated against known headings from GPS track data.

3. ~~**`advi` and `adeg` box contents**~~: **Resolved.** `advi` (§14) contains
   format version, hardware generation, MMP firmware version, and the source
   identifier string `"com.cosworth.outing.source.pdr2_5"`. Generation (offset
   12) and MMP version (offset 14) have been identified from cross-referencing
   four sample files across gen 1 and gen 2 hardware. `adeg` (§15) defines 20
   performance timing events (10 categories × start/end). Some numeric fields
   in `advi` (offsets 16–28) remain semantically unidentified.

---

## 18. Reference Implementation

See [`alivedrive_parser.py`](alivedrive_parser.py) in this directory for a working Python parser that
extracts all decoded channels to CSV. It supports both direct MP4 parsing and
pre-extracted raw binary files, and automatically detects the format variant
(legacy vs MMP v4+) from the dominant packet size.

```bash
# Direct from MP4
python protocol/alivedrive_parser.py ADV_0600.mp4 --csv output.csv

# From pre-extracted binary
python protocol/alivedrive_parser.py telemetry_raw.bin --raw --csv output.csv
```

> The parser implements all channel definitions, scale factors, and frame
> layouts documented in this specification, including dual-format support
> (17/25-byte 100 Hz frames, 31/34-byte 1 Hz frames), the full 1 Hz frame
> decode (27 channels), corrected 4-byte heading, and confirmed torque formula.

A TypeScript implementation is also available in `src/main/parser/` as
part of the OpenPDR Electron viewer application.
