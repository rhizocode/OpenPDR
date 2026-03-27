# GoPro GPMF Format

GoPro Metadata Format (GPMF) telemetry embedded in GoPro HERO5 and newer cameras.

## 1. MP4 Track Detection

GoPro GPMF data is stored in an MP4 metadata track identified by:
- **Handler type**: `meta` (in the `hdlr` box)
- **Codec type**: `gpmd` (in the `stsd` box)

Both must match within the same `trak` box. The `meta` handler type alone is too generic (many MP4 files have generic metadata tracks), so the `gpmd` codec is required for disambiguation.

## 2. KLV Binary Structure

Each MP4 sample contains approximately 1 second of GPMF data structured as nested KLV (Key-Length-Value) entries.

### Entry Layout (8+ bytes)

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 0 | 4 | FourCC | ASCII key (e.g. `GPS5`, `ACCL`, `DEVC`) |
| 4 | 1 | Type | Type character (0x00=container, `s`=int16, `l`=int32, `f`=float32, etc.) |
| 5 | 1 | Size | Bytes per struct element |
| 6 | 2 | Repeat | Number of elements (big-endian uint16) |
| 8+ | | Payload | Data, padded to 4-byte alignment |

### Type Codes

| Code | Char | Type |
|------|------|------|
| 0x00 | | Container (recurse into children) |
| 0x63 | `c` | ASCII string |
| 0x55 | `U` | UTC timestamp |
| 0x73 | `s` | Signed 16-bit integer |
| 0x53 | `S` | Unsigned 16-bit integer |
| 0x6C | `l` | Signed 32-bit integer |
| 0x4C | `L` | Unsigned 32-bit integer |
| 0x66 | `f` | 32-bit float |
| 0x46 | `F` | FourCC |

### Hierarchy

```
DEVC (device container)
  DVNM — device name string (e.g. "GoPro HERO10 Black")
  STRM (stream container)
    STNM — stream name
    SIUN — SI unit string
    SCAL — scale divisor(s)
    GPS5 / ACCL / GYRO — data payload
  STRM
    ...
```

**Sticky metadata**: Within each `STRM`, metadata keys (`STNM`, `SIUN`, `SCAL`) apply to subsequent data keys in the same stream.

## 3. Telemetry Streams

### GPS5 — GPS Position + Speed

5 components per row at ~9 Hz:

| Component | Units (after SCAL) | Typical SCAL |
|-----------|-------------------|--------------|
| Latitude | degrees | 10,000,000 |
| Longitude | degrees | 10,000,000 |
| Altitude | meters | 1,000 |
| 2D Speed | m/s | 1,000 |
| 3D Speed | m/s | 100 |

Data type: `l` (int32). Divide each component by its SCAL value.

### ACCL — Accelerometer

3 components per row at ~198 Hz (Hero10):

| Component | Raw Order | Vehicle Frame |
|-----------|-----------|---------------|
| Z | raw[0] | Vertical (gforce_vert) |
| X | raw[1] | Longitudinal (gforce_lon) |
| Y | raw[2] | Lateral (gforce_lat) |

Data type: `s` (int16). Divide by SCAL (typically 417). Result is m/s^2; divide by 9.80665 for g-force.

### GYRO — Gyroscope

3 components per row at ~198 Hz (Hero10):

| Component | Raw Order | Description |
|-----------|-----------|-------------|
| Z | raw[0] | Yaw rate |
| X | raw[1] | Pitch rate |
| Y | raw[2] | Roll rate |

Data type: `s` (int16). Divide by SCAL (typically 939). Result is rad/s; multiply by 180/pi for deg/s.

### Additional Metadata Keys

| Key | Type | Description |
|-----|------|-------------|
| GPSU | UTC | Recording timestamp (YYMMDDHHMMSS.SSS) |
| GPSF | int32 | GPS fix type (0=none, 2=2D, 3=3D) |
| GPSP | uint16 | GPS precision (DOP x 100) |
| DVNM | string | Device name |

## 4. Axis Remapping (Hero10)

GoPro Hero10 reports IMU data in camera body frame with axis order [Z, X, Y]. The decoder remaps to vehicle frame:

- **gforce_lat** = Y axis (raw component 2) / SCAL / 9.80665
- **gforce_lon** = X axis (raw component 1) / SCAL / 9.80665
- **gforce_vert** = Z axis (raw component 0) / SCAL / 9.80665

## 5. Resampling to 10 Hz

Each ~1 second GPMF sample contains:
- ~9 GPS points (9 Hz)
- ~198 accelerometer points (198 Hz)
- ~198 gyroscope points (198 Hz)

The decoder produces 10 output rows per sample (0.1s intervals):
- **GPS**: Nearest-neighbor interpolation from the 9 Hz grid
- **ACCL/GYRO**: Average all samples within each 0.1s bin (~20 samples per bin)
- **Heading**: Computed from consecutive GPS positions using `atan2(dlon * cos(lat), dlat)`

## 6. Channel Mapping to TelemetryStore

| Store Channel | Source | Notes |
|---------------|--------|-------|
| lat, lon | GPS5[0,1] | Degrees |
| altitude_m | GPS5[2] | Meters |
| speed_mps | GPS5[3] | 2D ground speed |
| speed_kph | GPS5[3] * 3.6 | |
| speed_mph | GPS5[3] * 2.23694 | |
| heading_deg | Computed | From consecutive GPS positions |
| gforce_lat | ACCL Y | g-force |
| gforce_lon | ACCL X | g-force |
| gforce_vert | ACCL Z | g-force |
| gyro_yaw_deg_s | GYRO Z | deg/s |
| gps_fix_quality | GPSF | 0/2/3 |

Vehicle-specific channels (RPM, brake, throttle, steering, gear, etc.) are not available from GoPro and remain at 0/undefined.

## 7. Implementation

| File | Purpose |
|------|---------|
| `src/parser/gopro/gpmf-decoder.ts` | GPMF binary KLV parser |
| `src/parser/gopro/gopro-decoder.ts` | GPMF streams to TelemetryStore at 10 Hz |
| `src/parser/format-detect.ts` | Format detection (matchBoth for `meta`+`gpmd`) |
| `src/parser/index.ts` | `parseGoPro()` entry point |

## 8. References

- [GoPro GPMF Parser (official)](https://github.com/gopro/gpmf-parser)
- [GPMF Spec](https://github.com/gopro/gpmf-parser/blob/main/docs/README.md)
