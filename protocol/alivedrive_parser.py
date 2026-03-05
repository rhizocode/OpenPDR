#!/usr/bin/env python3
"""
AliveDrive PDR 2.5 Telemetry Parser
Decodes telemetry data from AliveDrive/Cosworth PDR MP4 files (Cadillac CT5, etc.)

Reverse-engineered from the 'adco' data track format.
Uses deterministic frame offsets — no GPS coordinate scanning needed.
"""

import struct
import sys
import math
import csv
import os
from pathlib import Path


# =============================================================================
# Constants and Scale Factors (from adcp box — authoritative Cosworth definitions)
# =============================================================================

GPS_SCALE = 1.7453293e-09  # radians per raw unit (lat/lon i32)
DEG_SCALE = GPS_SCALE * 180.0 / math.pi  # degrees per raw unit (~1e-7)
ALT_SCALE = 0.001  # meters per raw unit
SPEED_SCALE = 0.00434028  # m/s per raw unit (ch 0)
ENGINE_SPEED_SCALE = 0.0261799388  # rad/s per raw unit (ch 29)
STEERING_SCALE = 0.001090831  # rad per raw unit (ch 42, i16)
HEADING_SCALE = 1.745329252e-07  # rad per raw unit (ch 4, i32 — 100x GPS scale)
HEADING_DEG_SCALE = HEADING_SCALE * 180.0 / math.pi

# Wheel speed uses a DIFFERENT angular velocity scale from engine speed
WHEEL_SPEED_SCALE = 0.0251327412  # rad/s per raw unit (ch 54-57)
# Effective tire rolling radius for CT5-V Blackwing 245/35R19 (compressed)
TIRE_RADIUS_M = 0.321  # best-fit vs GPS; nominal geometric = 0.337 m

# Engine torque encoding (confirmed from adcp: scale=0.5, offset=-848)
TORQUE_SCALE = 0.5  # N-m per raw unit
TORQUE_OFFSET = -848.0  # N-m offset (zero torque at raw=1696)

# Brake / throttle position
PROPORTION_SCALE = 1.0 / 255.0  # 0.00392157, maps 0-255 to 0.0-1.0

# Temperature encoding: temp_C = raw * scale + kelvin_offset - 273.15
TEMP_KELVIN_OFFSET = 233.15  # engine/trans/ambient temps: raw*scale - 40
TIRE_TEMP_KELVIN_OFFSET = 253.15  # tire temps: raw*scale - 20

# Pressure encoding
OIL_PRESSURE_SCALE = 4000  # Pa per raw unit (ch 26)
BOOST_PRESSURE_SCALE = 1000  # Pa per raw unit (ch 24)
TIRE_PRESSURE_SCALE = 4000  # Pa per raw unit (ch 45-48)

# Power encoding
POWER_SCALE = 500  # W per raw unit (ch 40, 41)

# Fuel level
FUEL_LEVEL_SCALE = 0.003921  # proportion per raw unit (ch 34)

# Odometer
ODOMETER_SCALE = 15.625  # metres per raw unit (ch 38)

# Gyro yaw rate
GYRO_YAW_SCALE = 0.00041887902  # rad/s per raw unit (ch 58)

# Conversion helpers
RAD_TO_RPM = 60.0 / (2.0 * math.pi)
MPS_TO_KPH = 3.6
MPS_TO_MPH = 2.23694
RAD_TO_DEG = 180.0 / math.pi

# Packet structure constants
PREAMBLE_SIZE = 14
EVENT_RECORD_SIZE = 11
TICKS_PER_SECOND = 10_000_000
FORMAT_IDENTIFIER = 0x0CA1


# =============================================================================
# Enum Value-to-Label Mappings (decoded from adcp box enum descriptors)
# =============================================================================

# Ch 7: ABS — Anti-Lock Braking System (10 Hz, subfield "status")
ENUM_ABS = {
    0: 'inactive',
    1: 'active',
    3: 'unknown',       # default
}

# Ch 17: Gear (5 Hz, subfield "current")
ENUM_GEAR = {
    0:  'notsupported',  # default — no gear data available
    1:  'first',
    2:  'second',
    3:  'third',
    4:  'fourth',
    5:  'fifth',
    6:  'sixth',
    7:  'seventh',
    8:  'eighth',
    9:  'ninth',
    10: 'tenth',
    11: 'unused',
    12: 'cvtforward',
    13: 'neutral',
    14: 'reverse',
    15: 'park',
}

# Ch 19: Drive Performance Mode (1 Hz, subfield "status")
ENUM_DRIVE_MODE = {
    0:  'none',           # default
    1:  'tour',
    2:  'sport',
    3:  'track',
    4:  'winter',
    5:  'offroad',
    6:  'towhaul',
    7:  'hold',
    8:  'mountain',
    9:  'personal',
    10: 'custom',
    11: 'awd',
    12: 'economy',
    13: 'automatic',
    14: 'ev',
    15: 'gradebraking',
    16: 'exhaustbrake',
    17: 'activerevmatch',
    18: '2wd',
    19: 'comfort',
    20: 'startstopdisable',
    21: 'crawl',
    22: 'chargeplus',
    23: 'baja',
    24: 'maxpower',
}

# Ch 20: E-Motor Axle Available (1 Hz, subfield "status")
ENUM_EMOTOR_AXLE = {
    0: 'notavailable',
    1: 'available',
    3: 'unknown',        # default
}

# Ch 30: Engine Start/Stop (5 Hz, subfield "state")
ENUM_ENGINE_STARTSTOP = {
    0: 'engineoff',       # note: firmware string is "engineofff" (triple-f typo)
    1: 'enginerunning',
    2: 'enginestarting',
    3: 'enginestopping',
    7: 'unknown',         # default
}

# Ch 33: ESC — Electronic Stability Control (5 Hz, subfield "status")
ENUM_ESC = {
    0: 'inactive',
    1: 'active',
    3: 'unknown',        # default
}

# Ch 39: PTM — Performance Traction Management (1 Hz, subfield "mode")
ENUM_PTM = {
    0: 'disabled',
    1: 'wet',
    2: 'dry',
    3: 'sport1',
    4: 'sport2',
    5: 'race',
    6: 'inactive',
    7: 'unknown',        # default
}

# Ch 43: TCS — Traction Control System (5 Hz, subfield "status")
ENUM_TCS = {
    0: 'inactive',
    1: 'active',
    3: 'unknown',        # default
}

# Ch 53: VSE — Vehicle Stability Enhancement (1 Hz, subfield "status")
# NOTE: VSE has OPPOSITE polarity from ABS/ESC/TCS (0 = active, 1 = inactive)
ENUM_VSE = {
    0: 'active',
    1: 'inactive',
    3: 'unknown',        # default
}

# Consolidated lookup: channel_field_name -> enum dict
ENUM_LABELS = {
    'abs_status':            ENUM_ABS,
    'gear':                  ENUM_GEAR,
    'drive_mode':            ENUM_DRIVE_MODE,
    'emotor_axle_available': ENUM_EMOTOR_AXLE,
    'engine_startstop':      ENUM_ENGINE_STARTSTOP,
    'esc_status':            ENUM_ESC,
    'ptm_mode':              ENUM_PTM,
    'tcs_status':            ENUM_TCS,
    'vse_status':            ENUM_VSE,
}


def enum_label(field_name, raw_value):
    """Look up the human-readable label for an enum channel's raw value."""
    mapping = ENUM_LABELS.get(field_name)
    if mapping is None:
        return str(raw_value)
    return mapping.get(raw_value, f'unknown_{raw_value}')


# =============================================================================
# MP4 Box Parser
# =============================================================================

def read_box_header(data, offset):
    """Read an MP4 box header, return (box_size, box_type, header_size, data_start)."""
    if offset + 8 > len(data):
        return None
    size = struct.unpack('>I', data[offset:offset+4])[0]
    box_type = data[offset+4:offset+8].decode('ascii', errors='replace')
    header_size = 8
    if size == 1:  # 64-bit extended size
        if offset + 16 > len(data):
            return None
        size = struct.unpack('>Q', data[offset+8:offset+16])[0]
        header_size = 16
    elif size == 0:
        size = len(data) - offset
    return size, box_type, header_size, offset + header_size


def scan_for_box(data, box_type):
    """Brute-force scan for a box by its 4-byte type tag anywhere in the file."""
    tag = box_type.encode('ascii') if isinstance(box_type, str) else box_type
    pos = 0
    while True:
        idx = data.find(tag, pos)
        if idx == -1 or idx < 4:
            return None
        size = struct.unpack('>I', data[idx - 4:idx])[0]
        if 8 < size < 100000:
            data_start = idx + 4
            return idx - 4, size, data_start
        pos = idx + 4
    return None


def find_box(data, box_type, offset=0, end=None):
    """Find a box by type within a range."""
    if end is None:
        end = len(data)
    while offset < end - 8:
        result = read_box_header(data, offset)
        if result is None:
            break
        size, btype, hdr_size, data_start = result
        if size < 8:
            break
        if btype == box_type:
            return offset, size, data_start
        offset += size
    return None


def find_box_path(data, path):
    """Find a nested box by path like 'moov/trak/mdia'."""
    parts = path.split('/')
    offset = 0
    end = len(data)
    for i, part in enumerate(parts):
        result = find_box(data, part, offset, end)
        if result is None:
            return None
        box_offset, box_size, data_start = result
        if i < len(parts) - 1:
            # Container box - search within
            offset = data_start
            end = box_offset + box_size
        else:
            return box_offset, box_size, data_start
    return None


# =============================================================================
# ADCO Track Parser
# =============================================================================

def find_all_boxes(data, box_type, offset=0, end=None, depth=0, max_depth=8):
    """Recursively find ALL boxes of a given type."""
    if end is None:
        end = len(data)
    if depth > max_depth:
        return []

    results = []
    pos = offset
    while pos < end - 8:
        result = read_box_header(data, pos)
        if result is None:
            break
        size, btype, hdr_size, data_start = result
        if size < 8:
            break
        box_end = pos + size
        if btype == box_type:
            results.append((pos, size, data_start))
        # Recurse into container boxes
        container_types = {'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta'}
        if btype in container_types:
            results.extend(find_all_boxes(data, box_type, data_start, box_end, depth+1, max_depth))
        pos = box_end
    return results


def find_adco_track(mp4_data):
    """Find the AliveDrive data track (adco/adrv handler) in the MP4."""
    moov = find_box(mp4_data, 'moov')
    if not moov:
        print("Error: Could not find moov box", file=sys.stderr)
        return None

    moov_offset, moov_size, moov_data = moov
    moov_end = moov_offset + moov_size

    pos = moov_data
    while pos < moov_end - 8:
        result = read_box_header(mp4_data, pos)
        if result is None:
            break
        size, btype, hdr_size, data_start = result
        if size < 8:
            break

        if btype == 'trak':
            trak_offset = pos
            trak_size = size
            trak_data = data_start
            trak_end = trak_offset + trak_size

            hdlr_results = find_all_boxes(mp4_data, 'hdlr', trak_data, trak_end)
            for h_off, h_size, h_data in hdlr_results:
                if h_data + 12 <= h_off + h_size:
                    handler_type = mp4_data[h_data+8:h_data+12].decode('ascii', errors='replace')
                    if handler_type == 'adrv':
                        return trak_offset, trak_size, trak_data, trak_end

            stsd_results = find_all_boxes(mp4_data, 'stsd', trak_data, trak_end)
            for s_off, s_size, s_data in stsd_results:
                if s_data + 16 <= s_off + s_size:
                    entry_start = s_data + 8
                    if entry_start + 8 <= s_off + s_size:
                        codec_type = mp4_data[entry_start+4:entry_start+8].decode('ascii', errors='replace')
                        if codec_type == 'adco':
                            return trak_offset, trak_size, trak_data, trak_end

        pos += size

    return None


def parse_adcp(data):
    """Parse channel definitions from the adcp box."""
    channel_names = {
        0: 'speed',
        1: 'location.latitude',
        2: 'location.longitude',
        3: 'location.altitude',
        4: 'location.heading',
        5: 'location.fixquality',
        6: 'location.satellites',
        7: 'stability.abs',
        8: 'accelerometer.device.x',
        9: 'accelerometer.device.y',
        10: 'accelerometer.device.z',
        11: 'accelerometer.vehicle.x',
        12: 'accelerometer.vehicle.y',
        13: 'accelerometer.vehicle.z',
        14: 'throttle.position',
        15: 'emotor.powerlevel',
        16: 'brake.position',
        17: 'gear',
        18: 'battery.hv.usablecharge',
        19: 'driveperformancemode',
        20: 'emotor.axleavailable',
        21: 'emotor.temperature.rotor',
        22: 'emotor.temperature.stator',
        23: 'engine.temperature.coolant',
        24: 'engine.pressure.boost',
        25: 'engine.temperature.airintake',
        26: 'engine.pressure.oil',
        27: 'engine.temperature.oil',
        28: 'engine.powerlevel',
        29: 'engine.speed',
        30: 'engine.startstop',
        31: 'engine.torque',
        32: 'temperature.outsideair',
        33: 'stability.esc',
        34: 'engine.level.fuel',
        35: 'battery.hv.temperature.avg',
        36: 'battery.hv.temperature.max',
        37: 'battery.hv.temperature.min',
        38: 'odometer.distance',
        39: 'ptm.mode',
        40: 'emotor.power',
        41: 'engine.power',
        42: 'steering.angle',
        43: 'stability.tcs',
        44: 'transmission.oil.temperature',
        45: 'tire.pressure.fl',
        46: 'tire.pressure.fr',
        47: 'tire.pressure.rl',
        48: 'tire.pressure.rr',
        49: 'tire.temperature.fl',
        50: 'tire.temperature.fr',
        51: 'tire.temperature.rl',
        52: 'tire.temperature.rr',
        53: 'stability.vse',
        54: 'wheel.speed.fl',
        55: 'wheel.speed.fr',
        56: 'wheel.speed.rl',
        57: 'wheel.speed.rr',
        58: 'gyro.yaw',
    }
    return channel_names


def parse_adcp_enums(data):
    """Parse enum descriptors from the adcp box payload.

    Reads the binary adcp payload and extracts the value-to-label mapping for
    every enum channel (type byte 0x02).  Returns a dict mapping
    channel_id -> { raw_value: label_string, ... }.
    """
    if len(data) < 4:
        return {}

    def _read_cstring(buf, off):
        start = off
        while off < len(buf) and buf[off] != 0:
            off += 1
        return buf[start:off].decode('ascii', errors='replace'), off + 1

    _BOUND_SIZES = {
        0x01: 1, 0x02: 1, 0x03: 2, 0x04: 2,
        0x05: 2, 0x06: 4, 0x09: 4, 0x0a: 4,
    }

    offset = 2  # skip 2-byte header
    enums = {}

    while offset < len(data) - 4:
        ch_id = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2
        _name, offset = _read_cstring(data, offset)
        if offset + 4 > len(data):
            break
        _unit_id = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2
        type_byte = data[offset]; offset += 1
        fmt_byte  = data[offset]; offset += 1

        if type_byte == 0x01:
            offset += 16
            bs = _BOUND_SIZES.get(fmt_byte, 0)
            if bs == 0:
                break
            offset += bs * 2
        elif type_byte == 0x02:
            num_subfields = data[offset]; offset += 1
            values = {}
            for _ in range(num_subfields):
                _sf_name, offset = _read_cstring(data, offset)
                _max_raw = data[offset]; offset += 1
                default_label, offset = _read_cstring(data, offset)
                default_value = data[offset]; offset += 1
                num_values = data[offset]; offset += 1
                values[default_value] = default_label
                for _ in range(num_values):
                    label, offset = _read_cstring(data, offset)
                    val = data[offset]; offset += 1
                    values[val] = label
            enums[ch_id] = values
        else:
            break

    return enums


def parse_adcr(data):
    """Parse the rate table from the adcr box payload."""
    offset = 0
    version = data[0]
    num_groups = data[2]
    offset = 4

    groups = []
    for g in range(num_groups):
        pad_size = 3 if g == 0 else 4
        offset += pad_size
        if offset + 6 > len(data):
            break
        period = struct.unpack('>I', data[offset:offset+4])[0]
        offset += 4
        num_channels = struct.unpack('>H', data[offset:offset+2])[0]
        offset += 2

        channels = []
        for c in range(num_channels):
            if offset + 3 > len(data):
                break
            ch_id = struct.unpack('>H', data[offset:offset+2])[0]
            offset += 2
            width = data[offset]
            offset += 1
            channels.append((ch_id, width))

        groups.append({
            'period': period,
            'num_channels': num_channels,
            'channels': channels,
            'total_width': sum(w for _, w in channels)
        })

    return groups


# =============================================================================
# Outing Properties Parser
# =============================================================================

def parse_adop(data):
    """Parse outing properties from adop box.

    Properties are stored as sequential key-value pairs:
      <null-terminated key> <4-byte type tag> <value>

    Type tags: strn (string), dtim (datetime), vrsn (version),
               siva (SI value), guid (UUID)
    """
    props = {}
    pos = 0
    PREFIX = 'com.cosworth.outingproperty.'

    while pos < len(data) - 5:
        # Read null-terminated key
        key_end = data.find(b'\x00', pos)
        if key_end == -1 or key_end == pos:
            break
        key = data[pos:key_end].decode('ascii', errors='replace')
        pos = key_end + 1

        # Strip common prefix for readability
        if key.startswith(PREFIX):
            key = key[len(PREFIX):]

        # Read 4-byte type tag
        if pos + 4 > len(data):
            break
        tag = data[pos:pos+4].decode('ascii', errors='replace')
        pos += 4

        if tag == 'strn':
            val_end = data.find(b'\x00', pos)
            if val_end == -1:
                break
            props[key] = data[pos:val_end].decode('ascii', errors='replace')
            pos = val_end + 1

        elif tag == 'dtim':
            if pos + 25 > len(data):
                break
            props[key] = data[pos:pos+25].decode('ascii', errors='replace')
            pos += 25

        elif tag == 'vrsn':
            if pos + 6 > len(data):
                break
            major = struct.unpack('>H', data[pos:pos+2])[0]
            minor = struct.unpack('>H', data[pos+2:pos+4])[0]
            patch = struct.unpack('>H', data[pos+4:pos+6])[0]
            props[key] = f'{major}.{minor}.{patch}'
            pos += 6

        elif tag == 'siva':
            if pos + 3 > len(data):
                break
            _reserved = data[pos]
            unit_id = data[pos + 1]
            val_type = data[pos + 2]
            pos += 3

            if val_type == 0x04:
                if pos + 2 > len(data):
                    break
                value = struct.unpack('>H', data[pos:pos+2])[0]
                pos += 2
            elif val_type == 0x09:
                if pos + 4 > len(data):
                    break
                value = struct.unpack('>f', data[pos:pos+4])[0]
                pos += 4
            elif val_type == 0x0a:
                if pos + 8 > len(data):
                    break
                value = struct.unpack('>d', data[pos:pos+8])[0]
                pos += 8
            else:
                break  # unknown value type

            props[key] = value

        elif tag == 'guid':
            if pos + 16 > len(data):
                break
            props[key] = data[pos:pos+16].hex()
            pos += 16

        else:
            break  # unknown tag type

    return props


# =============================================================================
# Sample Table Parser (stts, stsc, stsz, stco/co64)
# =============================================================================

def parse_sample_table(mp4_data, trak_data, trak_end):
    """Parse sample table entries to locate telemetry samples."""
    stbl = find_box(mp4_data, 'stbl', trak_data, trak_end)
    if not stbl:
        mdia = find_box(mp4_data, 'mdia', trak_data, trak_end)
        if mdia:
            minf = find_box(mp4_data, 'minf', mdia[2], mdia[0] + mdia[1])
            if minf:
                stbl = find_box(mp4_data, 'stbl', minf[2], minf[0] + minf[1])

    if not stbl:
        print("Error: Could not find sample table (stbl)", file=sys.stderr)
        return None

    stbl_offset, stbl_size, stbl_data = stbl
    stbl_end = stbl_offset + stbl_size

    # Parse stsz (sample sizes)
    stsz = find_box(mp4_data, 'stsz', stbl_data, stbl_end)
    if not stsz:
        print("Error: Could not find stsz", file=sys.stderr)
        return None

    stsz_data = stsz[2]
    stsz_version = struct.unpack('>I', mp4_data[stsz_data:stsz_data+4])[0]
    default_size = struct.unpack('>I', mp4_data[stsz_data+4:stsz_data+8])[0]
    sample_count = struct.unpack('>I', mp4_data[stsz_data+8:stsz_data+12])[0]

    sample_sizes = []
    if default_size != 0:
        sample_sizes = [default_size] * sample_count
    else:
        for i in range(sample_count):
            sz = struct.unpack('>I', mp4_data[stsz_data+12+i*4:stsz_data+16+i*4])[0]
            sample_sizes.append(sz)

    # Parse stco or co64 (chunk offsets)
    stco = find_box(mp4_data, 'stco', stbl_data, stbl_end)
    co64 = find_box(mp4_data, 'co64', stbl_data, stbl_end)

    chunk_offsets = []
    if co64:
        co64_data = co64[2]
        co_count = struct.unpack('>I', mp4_data[co64_data+4:co64_data+8])[0]
        for i in range(co_count):
            off = struct.unpack('>Q', mp4_data[co64_data+8+i*8:co64_data+16+i*8])[0]
            chunk_offsets.append(off)
    elif stco:
        stco_data = stco[2]
        co_count = struct.unpack('>I', mp4_data[stco_data+4:stco_data+8])[0]
        for i in range(co_count):
            off = struct.unpack('>I', mp4_data[stco_data+8+i*4:stco_data+12+i*4])[0]
            chunk_offsets.append(off)

    # Parse stsc (sample-to-chunk)
    stsc = find_box(mp4_data, 'stsc', stbl_data, stbl_end)
    stsc_entries = []
    if stsc:
        stsc_data = stsc[2]
        stsc_count = struct.unpack('>I', mp4_data[stsc_data+4:stsc_data+8])[0]
        for i in range(stsc_count):
            first_chunk = struct.unpack('>I', mp4_data[stsc_data+8+i*12:stsc_data+12+i*12])[0]
            samples_per_chunk = struct.unpack('>I', mp4_data[stsc_data+12+i*12:stsc_data+16+i*12])[0]
            desc_idx = struct.unpack('>I', mp4_data[stsc_data+16+i*12:stsc_data+20+i*12])[0]
            stsc_entries.append((first_chunk, samples_per_chunk, desc_idx))

    return {
        'sample_sizes': sample_sizes,
        'chunk_offsets': chunk_offsets,
        'stsc_entries': stsc_entries,
        'sample_count': sample_count
    }


def get_sample_offsets(sample_table):
    """Compute absolute file offset for each sample."""
    offsets = []
    stsc = sample_table['stsc_entries']
    chunks = sample_table['chunk_offsets']
    sizes = sample_table['sample_sizes']

    sample_idx = 0
    for chunk_idx in range(len(chunks)):
        chunk_num = chunk_idx + 1
        samples_per_chunk = 1
        for entry_idx, (first_chunk, spc, _) in enumerate(stsc):
            if first_chunk <= chunk_num:
                samples_per_chunk = spc
            else:
                break

        offset = chunks[chunk_idx]
        for s in range(samples_per_chunk):
            if sample_idx >= len(sizes):
                break
            offsets.append(offset)
            offset += sizes[sample_idx]
            sample_idx += 1

    return offsets


# =============================================================================
# Track Timing (mdhd + stts + edts/elst) for video sync
# =============================================================================

def parse_track_timing(mp4_data, trak_data, trak_end, mvhd_timescale, sample_count):
    """Parse mdhd timescale, stts sample durations, and edts/elst delay.

    Returns a list of per-sample presentation times in seconds, or None
    if the required boxes are not found.
    """
    # Find mdia box
    mdia = find_box(mp4_data, 'mdia', trak_data, trak_end)
    if not mdia:
        return None
    mdia_end = mdia[0] + mdia[1]

    # -- mdhd (media header) --
    mdhd = find_box(mp4_data, 'mdhd', mdia[2], mdia_end)
    if not mdhd:
        return None
    d = mdhd[2]
    version = mp4_data[d]
    if version == 0:
        timescale = struct.unpack('>I', mp4_data[d+12:d+16])[0]
    else:
        timescale = struct.unpack('>I', mp4_data[d+20:d+24])[0]
    if timescale == 0:
        return None

    # -- stts (decoding time to sample) --
    minf = find_box(mp4_data, 'minf', mdia[2], mdia_end)
    if not minf:
        return None
    stbl = find_box(mp4_data, 'stbl', minf[2], minf[0] + minf[1])
    if not stbl:
        return None
    stbl_end = stbl[0] + stbl[1]

    stts = find_box(mp4_data, 'stts', stbl[2], stbl_end)
    if not stts:
        return None
    stts_d = stts[2]
    entry_count = struct.unpack('>I', mp4_data[stts_d+4:stts_d+8])[0]
    stts_entries = []
    pos = stts_d + 8
    for _ in range(entry_count):
        count = struct.unpack('>I', mp4_data[pos:pos+4])[0]
        delta = struct.unpack('>I', mp4_data[pos+4:pos+8])[0]
        stts_entries.append((count, delta))
        pos += 8

    # -- edts/elst (edit list) --
    elst_delay = 0.0
    edts = find_box(mp4_data, 'edts', trak_data, trak_end)
    if edts:
        edts_end = edts[0] + edts[1]
        elst = find_box(mp4_data, 'elst', edts[2], edts_end)
        if elst:
            ed = elst[2]
            e_version = mp4_data[ed]
            e_count = struct.unpack('>I', mp4_data[ed+4:ed+8])[0]
            epos = ed + 8
            for _ in range(e_count):
                if e_version == 0:
                    seg_dur = struct.unpack('>I', mp4_data[epos:epos+4])[0]
                    media_time = struct.unpack('>i', mp4_data[epos+4:epos+8])[0]
                    epos += 12  # +4 for media_rate
                else:
                    seg_dur = struct.unpack('>Q', mp4_data[epos:epos+8])[0]
                    media_time = struct.unpack('>q', mp4_data[epos+8:epos+16])[0]
                    epos += 20
                if media_time == -1 and mvhd_timescale > 0:
                    elst_delay += seg_dur / mvhd_timescale

    # -- Build per-sample presentation times --
    sample_times = []
    cumulative = elst_delay
    sample_idx = 0
    for count, delta in stts_entries:
        delta_sec = delta / timescale
        for _ in range(count):
            if sample_idx >= sample_count:
                break
            sample_times.append(cumulative)
            cumulative += delta_sec
            sample_idx += 1
    # Fill remaining (shouldn't happen)
    while len(sample_times) < sample_count:
        sample_times.append(cumulative)
        cumulative += 1.0

    return sample_times


def parse_mvhd_timescale(mp4_data):
    """Parse the mvhd box to get the global movie timescale."""
    moov = find_box(mp4_data, 'moov')
    if not moov:
        return 1000
    moov_end = moov[0] + moov[1]
    mvhd = find_box(mp4_data, 'mvhd', moov[2], moov_end)
    if not mvhd:
        return 1000
    d = mvhd[2]
    version = mp4_data[d]
    ts_offset = 12 if version == 0 else 20
    return struct.unpack('>I', mp4_data[d+ts_offset:d+ts_offset+4])[0]


# =============================================================================
# Deterministic Frame Offset Computation
# =============================================================================

def compute_lat_offsets(hz100_size):
    """Pre-compute all 10 GPS latitude byte offsets within a packet.

    The packet structure is completely deterministic — the spacing between
    each 10 Hz frame depends only on which optional sparse blocks that
    frame contains. No GPS scanning needed.

    Verified 100% match across 2,290 packets from 4 vehicles (3 legacy,
    1 MMP v4+).
    """
    hz1_size = 34 if hz100_size == 25 else 31
    group_size = 2 * hz100_size + 24   # [100Hz][100Hz][50Hz]
    carry_over = hz100_size + 24       # second 100Hz + 50Hz from prev second

    offsets = [0] * 10
    offsets[0] = PREAMBLE_SIZE + carry_over + 2  # +2 for speed field before lat

    for i in range(1, 10):
        prev = i - 1
        spacing = 28 + 5 * group_size       # base: 10Hz(28B) + 5x group
        if prev % 2 == 0:
            spacing += 4                     # +4 for 5Hz on even frames
        if prev in (0, 5):
            spacing += 1                     # +1 for 2Hz on frames 0,5
        if prev == 0:
            spacing += hz1_size              # +31/34 for 1Hz on frame 0
        offsets[i] = offsets[prev] + spacing

    return offsets


# Pre-compute for both format variants
LAT_OFFSETS_LEGACY = compute_lat_offsets(17)  # [57, 411, 729, ...]
LAT_OFFSETS_V4 = compute_lat_offsets(25)      # [65, 502, 900, ...]


# =============================================================================
# Telemetry Decoder
# =============================================================================

def decode_100hz_frame(packet, offset, hz100_size=17):
    """Decode a 100Hz sub-frame.

    MMP <= 3 (17 bytes): wheel speeds are u16 angular velocity
    MMP >= 4 (25 bytes): wheel speeds are float32 m/s
    """
    if offset < 0 or offset + hz100_size > len(packet):
        return None

    frame = packet[offset:offset + hz100_size]

    torque_raw = struct.unpack('>H', frame[3:5])[0]

    if hz100_size == 25:
        ws_fl_mps = struct.unpack('>f', frame[7:11])[0]
        ws_fr_mps = struct.unpack('>f', frame[11:15])[0]
        ws_rl_mps = struct.unpack('>f', frame[15:19])[0]
        ws_rr_mps = struct.unpack('>f', frame[19:23])[0]
        gyro_raw = struct.unpack('>h', frame[23:25])[0]

        return {
            'brake_position': frame[0] * PROPORTION_SCALE,
            'engine_rpm': struct.unpack('>H', frame[1:3])[0] * ENGINE_SPEED_SCALE * RAD_TO_RPM,
            'engine_torque_raw': torque_raw,
            'engine_torque_nm': torque_raw * TORQUE_SCALE + TORQUE_OFFSET,
            'steering_angle_deg': struct.unpack('>h', frame[5:7])[0] * STEERING_SCALE * RAD_TO_DEG,
            'wheel_speed_fl_kph': ws_fl_mps * MPS_TO_KPH,
            'wheel_speed_fr_kph': ws_fr_mps * MPS_TO_KPH,
            'wheel_speed_rl_kph': ws_rl_mps * MPS_TO_KPH,
            'wheel_speed_rr_kph': ws_rr_mps * MPS_TO_KPH,
            'gyro_yaw_deg_s': gyro_raw * GYRO_YAW_SCALE * RAD_TO_DEG,
        }
    else:
        ws_fl_raw = struct.unpack('>H', frame[7:9])[0]
        ws_fr_raw = struct.unpack('>H', frame[9:11])[0]
        ws_rl_raw = struct.unpack('>H', frame[11:13])[0]
        ws_rr_raw = struct.unpack('>H', frame[13:15])[0]
        gyro_raw = struct.unpack('>h', frame[15:17])[0]

        return {
            'brake_position': frame[0] * PROPORTION_SCALE,
            'engine_rpm': struct.unpack('>H', frame[1:3])[0] * ENGINE_SPEED_SCALE * RAD_TO_RPM,
            'engine_torque_raw': torque_raw,
            'engine_torque_nm': torque_raw * TORQUE_SCALE + TORQUE_OFFSET,
            'steering_angle_deg': struct.unpack('>h', frame[5:7])[0] * STEERING_SCALE * RAD_TO_DEG,
            'wheel_speed_fl_kph': ws_fl_raw * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
            'wheel_speed_fr_kph': ws_fr_raw * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
            'wheel_speed_rl_kph': ws_rl_raw * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
            'wheel_speed_rr_kph': ws_rr_raw * WHEEL_SPEED_SCALE * TIRE_RADIUS_M * MPS_TO_KPH,
            'gyro_yaw_deg_s': gyro_raw * GYRO_YAW_SCALE * RAD_TO_DEG,
        }


def decode_50hz_frame(packet, offset):
    """Decode a 50Hz sub-frame (24 bytes = 6 x float32).

    Two independent 3-axis accelerometer readings in g:
    - Device (ch 8-10): raw sensor frame (tilted ~17deg from vehicle vertical)
    - Vehicle (ch 11-13): gravity-compensated vehicle-frame-aligned
    """
    if offset + 24 > len(packet):
        return None

    floats = []
    for i in range(6):
        floats.append(struct.unpack('>f', packet[offset+i*4:offset+i*4+4])[0])

    return {
        'accel_device_x_g': floats[0],
        'accel_device_y_g': floats[1],
        'accel_device_z_g': floats[2],
        'accel_vehicle_x_g': floats[3],
        'accel_vehicle_y_g': floats[4],
        'accel_vehicle_z_g': floats[5],
    }


def decode_10hz_frame(packet, lat_offset):
    """Decode a 10Hz group 2 frame (28 bytes starting from speed, 2 bytes before lat).

    Layout: speed(2) lat(4) lon(4) alt(4) heading(4) fix(1) sat(1)
            ABS(1) throttle(1) boost(2) emotor_power(2) engine_power(2)
    """
    if lat_offset + 26 > len(packet):
        return None

    lat_raw = struct.unpack('>i', packet[lat_offset:lat_offset+4])[0]
    lon_raw = struct.unpack('>i', packet[lat_offset+4:lat_offset+8])[0]
    alt_raw = struct.unpack('>i', packet[lat_offset+8:lat_offset+12])[0]
    heading_raw = struct.unpack('>i', packet[lat_offset+12:lat_offset+16])[0]
    fixquality = packet[lat_offset+16]
    satellites = packet[lat_offset+17]
    abs_status = packet[lat_offset+18]
    throttle_raw = packet[lat_offset+19]
    boost_raw = struct.unpack('>H', packet[lat_offset+20:lat_offset+22])[0]
    emotor_raw = struct.unpack('>H', packet[lat_offset+22:lat_offset+24])[0]
    engine_raw = struct.unpack('>H', packet[lat_offset+24:lat_offset+26])[0]

    # Speed is 2 bytes BEFORE lat
    speed_raw = 0
    if lat_offset >= 2:
        speed_raw = struct.unpack('>H', packet[lat_offset-2:lat_offset])[0]

    return {
        'latitude_deg': lat_raw * DEG_SCALE,
        'longitude_deg': lon_raw * DEG_SCALE,
        'altitude_m': alt_raw * ALT_SCALE,
        'heading_deg': heading_raw * HEADING_DEG_SCALE,
        'speed_mps': speed_raw * SPEED_SCALE,
        'speed_kph': speed_raw * SPEED_SCALE * MPS_TO_KPH,
        'speed_mph': speed_raw * SPEED_SCALE * MPS_TO_MPH,
        'gps_fix_quality': fixquality,
        'gps_satellites': satellites,
        'abs_status': abs_status,
        'abs_status_label': enum_label('abs_status', abs_status),
        'throttle_position': throttle_raw * PROPORTION_SCALE,
        'boost_pressure_kpa': boost_raw * BOOST_PRESSURE_SCALE / 1000.0,
        'emotor_power_kw': emotor_raw * POWER_SCALE / 1000.0,
        'engine_power_kw': engine_raw * POWER_SCALE / 1000.0,
    }


def decode_5hz_frame(packet, offset):
    """Decode 5Hz data (4 bytes): gear, startstop, ESC, TCS."""
    if offset + 4 > len(packet):
        return None
    gear_raw = packet[offset]
    startstop_raw = packet[offset+1]
    esc_raw = packet[offset+2]
    tcs_raw = packet[offset+3]
    return {
        'gear': gear_raw,
        'gear_label': enum_label('gear', gear_raw),
        'engine_startstop': startstop_raw,
        'engine_startstop_label': enum_label('engine_startstop', startstop_raw),
        'esc_status': esc_raw,
        'esc_status_label': enum_label('esc_status', esc_raw),
        'tcs_status': tcs_raw,
        'tcs_status_label': enum_label('tcs_status', tcs_raw),
    }


def decode_1hz_frame(packet, offset, hz1_size=31):
    """Decode the full 1 Hz frame at the given byte offset.

    MMP <= 3 (31 bytes): drive_mode is u8 at b[3]
    MMP >= 4 (34 bytes): drive_mode is u32 at b[3:7], shifting everything after by 3
    """
    if offset + hz1_size > len(packet):
        return None

    b = packet[offset:offset + hz1_size]

    hv_charge_raw = struct.unpack('>H', b[1:3])[0]

    if hz1_size == 34:
        dm_raw = struct.unpack('>I', b[3:7])[0]
        s = 3  # shift for all fields after drive_mode
    else:
        dm_raw = b[3]
        s = 0

    odometer_raw = struct.unpack('>I', b[16+s:20+s])[0]

    return {
        'emotor_powerlevel': b[0] * 0.01,
        'hv_battery_charge': hv_charge_raw * 1.5259e-5,
        'drive_mode': dm_raw & 0xFF,
        'drive_mode_label': enum_label('drive_mode', dm_raw & 0xFF),
        'emotor_axle_available': b[4+s],
        'emotor_axle_available_label': enum_label('emotor_axle_available', b[4+s]),
        'emotor_temp_rotor_c': b[5+s] - 40 if b[5+s] > 0 else None,
        'emotor_temp_stator_c': b[6+s] - 40 if b[6+s] > 0 else None,
        'engine_temp_coolant_c': b[7+s] - 40,
        'engine_temp_airintake_c': b[8+s] - 40,
        'engine_temp_oil_c': b[9+s] - 40,
        'engine_powerlevel': b[10+s] * 0.01,
        'outside_air_temp_c': b[11+s] * 0.5 - 40,
        'fuel_level_pct': b[12+s] * FUEL_LEVEL_SCALE * 100.0,
        'hv_battery_temp_avg_c': b[13+s] - 40 if b[13+s] > 0 else None,
        'hv_battery_temp_max_c': b[14+s] * 0.5 - 40 if b[14+s] > 0 else None,
        'hv_battery_temp_min_c': b[15+s] * 0.5 - 40 if b[15+s] > 0 else None,
        'odometer_km': odometer_raw * ODOMETER_SCALE / 1000.0,
        'ptm_mode': b[20+s],
        'ptm_mode_label': enum_label('ptm_mode', b[20+s]),
        'trans_oil_temp_c': b[21+s] - 40,
        'tire_pressure_fl_kpa': b[22+s] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_pressure_fr_kpa': b[23+s] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_pressure_rl_kpa': b[24+s] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_pressure_rr_kpa': b[25+s] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_temp_fl_c': b[26+s] - 20,
        'tire_temp_fr_c': b[27+s] - 20,
        'tire_temp_rl_c': b[28+s] - 20,
        'tire_temp_rr_c': b[29+s] - 20,
        'vse_status': b[30+s],
        'vse_status_label': enum_label('vse_status', b[30+s]),
    }


def _validate_100hz(frame):
    """Sanity-check a decoded 100Hz frame."""
    if abs(frame['engine_rpm']) > 12000:
        return False
    for key in ('wheel_speed_fl_kph', 'wheel_speed_fr_kph',
                'wheel_speed_rl_kph', 'wheel_speed_rr_kph'):
        if abs(frame[key]) > 400:
            return False
    return True


def decode_packet(packet, packet_idx, hz100_size=17, lat_offsets=None,
                   base_time=None):
    """Decode a complete telemetry packet using deterministic frame offsets.

    No GPS scanning — all byte positions are computed mathematically from
    the format variant (hz100_size).

    Args:
        packet: Raw packet bytes
        packet_idx: Packet index (used for timestamp calculation fallback)
        hz100_size: 100Hz sub-frame size (17 for MMP ≤ 3, 25 for MMP ≥ 4)
        lat_offsets: Pre-computed GPS latitude offsets (auto-selected if None)
        base_time: Presentation time in seconds from MP4 stts/elst timing.
                   Falls back to packet_idx if not provided.

    Returns a list of decoded records (one per 10Hz frame, up to 10).
    """
    if len(packet) < 100:
        return []  # Skip init packet

    hz1_size = 34 if hz100_size == 25 else 31
    group_size = 2 * hz100_size + 24  # [100Hz][100Hz][50Hz]

    if lat_offsets is None:
        lat_offsets = LAT_OFFSETS_V4 if hz100_size == 25 else LAT_OFFSETS_LEGACY

    records = []
    if base_time is None:
        base_time = packet_idx  # fallback: assume 1 second per packet

    for frame_idx in range(10):
        lat_off = lat_offsets[frame_idx]
        if lat_off + 26 > len(packet):
            break

        frame_time = base_time + frame_idx * 0.1

        # --- 10Hz frame (28 bytes) ---
        g2 = decode_10hz_frame(packet, lat_off)
        if g2 is None:
            continue

        # Compute cursor past the 10Hz frame
        cursor = lat_off + 26

        # --- 5Hz (even frames: 0, 2, 4, 6, 8) ---
        hz5_data = None
        if frame_idx % 2 == 0:
            hz5_data = decode_5hz_frame(packet, cursor)
            cursor += 4

        # --- 2Hz (frames 0 and 5) ---
        oil_pressure_kpa = None
        if frame_idx in (0, 5):
            if cursor < len(packet):
                oil_pressure_kpa = packet[cursor] * OIL_PRESSURE_SCALE / 1000.0
            cursor += 1

        # --- 1Hz (frame 0 only) ---
        hz1_data = None
        if frame_idx == 0:
            hz1_data = decode_1hz_frame(packet, cursor, hz1_size)
            cursor += hz1_size

        # --- High-rate sub-groups (100Hz + 100Hz + 50Hz) x 5 ---
        # Frame 9: only 4 complete sub-groups fit; the 5th overflows to next packet
        num_complete_groups = 4 if frame_idx == 9 else 5
        hz100_frames = []
        hz50_frames = []

        for j in range(num_complete_groups):
            base = cursor + j * group_size

            f1 = decode_100hz_frame(packet, base, hz100_size)
            if f1 and _validate_100hz(f1):
                hz100_frames.append(f1)

            f2 = decode_100hz_frame(packet, base + hz100_size, hz100_size)
            if f2 and _validate_100hz(f2):
                hz100_frames.append(f2)

            f50 = decode_50hz_frame(packet, base + 2 * hz100_size)
            if f50:
                hz50_frames.append(f50)

        # Frame 9: decode the extra 100Hz from the partial 5th sub-group
        if frame_idx == 9:
            extra_off = cursor + 4 * group_size
            f_extra = decode_100hz_frame(packet, extra_off, hz100_size)
            if f_extra and _validate_100hz(f_extra):
                hz100_frames.append(f_extra)

        # --- Build record ---
        record = {
            'packet_idx': packet_idx,
            'frame_idx': frame_idx,
            'time_s': frame_time,
        }
        record.update(g2)

        # Average 100Hz data for this period
        if hz100_frames:
            n = len(hz100_frames)
            for key in ('brake_position', 'engine_rpm', 'engine_torque_nm',
                        'steering_angle_deg', 'gyro_yaw_deg_s',
                        'wheel_speed_fl_kph', 'wheel_speed_fr_kph',
                        'wheel_speed_rl_kph', 'wheel_speed_rr_kph'):
                record[key] = sum(f[key] for f in hz100_frames) / n

        # Average 50Hz data (gravity-compensated vehicle-frame values)
        if hz50_frames:
            n = len(hz50_frames)
            record['accel_lateral_g'] = sum(f['accel_vehicle_x_g'] for f in hz50_frames) / n
            record['accel_longitudinal_g'] = sum(f['accel_vehicle_y_g'] for f in hz50_frames) / n
            record['accel_vertical_g'] = sum(f['accel_vehicle_z_g'] for f in hz50_frames) / n

        if hz5_data:
            record.update(hz5_data)

        if oil_pressure_kpa is not None:
            record['oil_pressure_kpa'] = oil_pressure_kpa

        if hz1_data:
            record.update(hz1_data)

        records.append(record)

    return records


# =============================================================================
# Event Extraction
# =============================================================================

def extract_events(packet, nominal_size, event_defs=None):
    """Extract embedded event records from oversized packets.

    When events fire during a 1-second telemetry window, the firmware
    appends 11-byte event records to the end of the packet:
      u64 BE  timestamp (100 ns ticks from recording start)
      u16 BE  flags (observed: 0x0200)
      u8      event_id (0-19, maps to adeg definitions)
    """
    if len(packet) <= nominal_size:
        return []

    extra = packet[nominal_size:]
    if len(extra) % EVENT_RECORD_SIZE != 0:
        return []

    # Build event name lookup from definitions
    event_name_map = {}
    if event_defs:
        for eid, ename in event_defs:
            event_name_map[eid] = ename

    events = []
    num_events = len(extra) // EVENT_RECORD_SIZE

    for i in range(num_events):
        off = i * EVENT_RECORD_SIZE

        # u64 BE timestamp (100 ns ticks)
        ts_hi = struct.unpack('>I', extra[off:off+4])[0]
        ts_lo = struct.unpack('>I', extra[off+4:off+8])[0]
        time_s = (ts_hi * 0x100000000 + ts_lo) / TICKS_PER_SECOND

        flags = struct.unpack('>H', extra[off+8:off+10])[0]
        event_id = extra[off+10]

        event_name = event_name_map.get(event_id, f'unknown_event_{event_id}')

        events.append({
            'event_id': event_id,
            'event_name': event_name,
            'time_s': time_s,
            'flags': flags,
        })

    return events


# =============================================================================
# Version Info Parser
# =============================================================================

def parse_advi(data):
    """Parse version info from advi box.

    Key fields (offsets from box payload start):
      [0:2]  format_version (u16 BE) — 5 = PDR 2.5
      [4:6]  generation (u16 BE) — 1=gen1, 2=gen2
      [6:8]  mmp_version (u16 BE) — MMP firmware version
      [22:]  null-terminated source identifier string
    """
    info = {}
    if len(data) < 24:
        return info

    info['format_version'] = struct.unpack('>H', data[0:2])[0]
    info['generation'] = struct.unpack('>H', data[4:6])[0]
    info['mmp_version'] = struct.unpack('>H', data[6:8])[0]

    str_start = 22
    if str_start < len(data):
        end = data.find(b'\x00', str_start)
        if end != -1:
            info['source'] = data[str_start:end].decode('ascii', errors='replace')

    return info


# =============================================================================
# Event Definitions Parser
# =============================================================================

def parse_adeg(data):
    """Parse event definitions from adeg box.

    Returns a list of (event_id, event_name) tuples.
    """
    events = []
    pos = 0
    while pos < len(data) - 2:
        event_id = struct.unpack('>H', data[pos:pos + 2])[0]
        pos += 2
        end = data.find(b'\x00', pos)
        if end == -1:
            break
        name = data[pos:end].decode('ascii', errors='replace')
        pos = end + 1
        events.append((event_id, name))
    return events


# =============================================================================
# Main Extraction Pipeline
# =============================================================================

def extract_telemetry(mp4_path, csv_path=None, verbose=False):
    """Extract telemetry from an AliveDrive PDR MP4 file.

    Uses deterministic frame offsets — no GPS scanning needed.
    """
    mp4_path = Path(mp4_path)
    if not mp4_path.exists():
        print(f"Error: File not found: {mp4_path}", file=sys.stderr)
        return None

    print(f"Reading {mp4_path.name}...")
    with open(mp4_path, 'rb') as f:
        mp4_data = f.read()

    print(f"File size: {len(mp4_data) / (1024**2):.1f} MB")

    # Find the ADCO data track
    track_info = find_adco_track(mp4_data)
    if not track_info:
        print("Error: Could not find AliveDrive data track (adrv handler)", file=sys.stderr)
        return None

    trak_offset, trak_size, trak_data, trak_end = track_info
    print("Found AliveDrive data track")

    # Parse sample table
    sample_table = parse_sample_table(mp4_data, trak_data, trak_end)
    if not sample_table:
        print("Error: Could not parse sample table", file=sys.stderr)
        return None

    print(f"Found {sample_table['sample_count']} telemetry samples")

    # Get sample offsets
    sample_offsets = get_sample_offsets(sample_table)
    sample_sizes = sample_table['sample_sizes']

    if verbose:
        sizes = {}
        for s in sample_sizes:
            sizes[s] = sizes.get(s, 0) + 1
        print(f"Sample sizes: {dict(sorted(sizes.items()))}")

    # Parse version info (advi)
    advi_info = {}
    advi_box = scan_for_box(mp4_data, 'advi')
    if advi_box:
        advi_data = mp4_data[advi_box[2]:advi_box[0]+advi_box[1]]
        advi_info = parse_advi(advi_data)
        if verbose and advi_info:
            print(f"Format version: {advi_info.get('format_version', '?')}")
            print(f"MMP version: {advi_info.get('mmp_version', '?')} "
                  f"(gen {advi_info.get('generation', '?')})")
            print(f"Source: {advi_info.get('source', '?')}")

    # Determine 100Hz frame size from dominant packet size
    dominant_pkt_size = max(set(sample_sizes), key=sample_sizes.count) if sample_sizes else 0
    hz100_size = 25 if dominant_pkt_size > 3500 else 17
    nominal_size = 4050 if hz100_size == 25 else 3247
    lat_offsets = LAT_OFFSETS_V4 if hz100_size == 25 else LAT_OFFSETS_LEGACY
    print(f"Dominant packet size {dominant_pkt_size}: using {hz100_size}-byte 100Hz frames"
          f" (MMP v{advi_info.get('mmp_version', '?')}, "
          f"gen {advi_info.get('generation', '?')})")

    # Parse event definitions (adeg)
    event_defs = []
    adeg_box = scan_for_box(mp4_data, 'adeg')
    if adeg_box:
        adeg_data = mp4_data[adeg_box[2]:adeg_box[0]+adeg_box[1]]
        event_defs = parse_adeg(adeg_data)
        if verbose and event_defs:
            print(f"Event definitions: {len(event_defs)} events")
            for eid, ename in event_defs:
                print(f"  {eid:2d}: {ename}")

    # Parse outing properties (adop) — for metadata display
    adop_box = scan_for_box(mp4_data, 'adop')
    if adop_box:
        adop_data = mp4_data[adop_box[2]:adop_box[0]+adop_box[1]]
        adop_props = parse_adop(adop_data)
        if verbose and adop_props:
            print(f"Outing properties: {len(adop_props)} entries")
            for k, v in sorted(adop_props.items()):
                if isinstance(v, float):
                    print(f"  {k}: {v:.6f}")
                else:
                    print(f"  {k}: {v}")
        # Print key metadata
        vehicle = adop_props.get('vehicle.make', adop_props.get('carname', ''))
        engine = adop_props.get('vehicle.enginetype', '')
        timestamp = adop_props.get('timestamp', '')
        if vehicle:
            print(f"Vehicle: {vehicle}" + (f" ({engine})" if engine else ""))
        if timestamp:
            print(f"Recording: {timestamp}")
        # Print GPS reference from adop (informational only — not needed for parsing)
        center_lat = adop_props.get('location.center.latitude')
        center_lon = adop_props.get('location.center.longitude')
        if center_lat is not None and center_lon is not None:
            print(f"Location center: {center_lat * RAD_TO_DEG:.4f}deg, "
                  f"{center_lon * RAD_TO_DEG:.4f}deg")

    # Parse adcp for dynamic enum labels (if available)
    adcp_box = scan_for_box(mp4_data, 'adcp')
    if adcp_box:
        adcp_data = mp4_data[adcp_box[2]:adcp_box[0]+adcp_box[1]]
        dynamic_enums = parse_adcp_enums(adcp_data)
        if dynamic_enums and verbose:
            print(f"Parsed {len(dynamic_enums)} enum channel definitions from adcp")
        # Map channel IDs to our field names for ENUM_LABELS override
        ch_to_field = {
            7: 'abs_status', 17: 'gear', 19: 'drive_mode',
            20: 'emotor_axle_available', 30: 'engine_startstop',
            33: 'esc_status', 39: 'ptm_mode', 43: 'tcs_status',
            53: 'vse_status',
        }
        for ch_id, values in dynamic_enums.items():
            field = ch_to_field.get(ch_id)
            if field:
                ENUM_LABELS[field] = values

    # Parse track timing (mdhd + stts + edts/elst) for proper video sync
    mvhd_timescale = parse_mvhd_timescale(mp4_data)
    sample_times = parse_track_timing(
        mp4_data, trak_data, trak_end, mvhd_timescale,
        sample_table['sample_count'])
    if sample_times:
        elst_delay = sample_times[0] if sample_times else 0
        print(f"Track timing: timescale={mvhd_timescale}, elst_delay={elst_delay:.3f}s, "
              f"first data at {sample_times[1] if len(sample_times) > 1 else '?'}s")
    else:
        print("Warning: Could not parse track timing; using packet index for timestamps")

    # Decode all packets using deterministic offsets
    print("Decoding telemetry packets...")
    all_records = []
    all_events = []
    decoded_packets = 0
    failed_packets = 0

    for pkt_idx in range(len(sample_offsets)):
        off = sample_offsets[pkt_idx]
        sz = sample_sizes[pkt_idx]
        packet = mp4_data[off:off+sz]

        if sz < 100:
            continue  # Skip init packet

        pkt_time = sample_times[pkt_idx] if sample_times else None
        records = decode_packet(packet, pkt_idx, hz100_size, lat_offsets,
                                base_time=pkt_time)
        if records:
            all_records.extend(records)
            decoded_packets += 1
        else:
            failed_packets += 1

        # Extract embedded events from oversized packets
        events = extract_events(packet, nominal_size, event_defs)
        if events:
            all_events.extend(events)

        if verbose and pkt_idx % 100 == 0:
            print(f"  Processed {pkt_idx}/{len(sample_offsets)} packets "
                  f"({len(all_records)} records)")

    print(f"Decoded {decoded_packets} packets ({failed_packets} failed)")
    print(f"Total records: {len(all_records)}")

    if all_events:
        print(f"Embedded events: {len(all_events)}")
        # Print lap timing events
        lap_starts = [e for e in all_events if e['event_id'] == 0]
        if lap_starts:
            print(f"  Lap start events: {len(lap_starts)}")
            for i, e in enumerate(lap_starts):
                if i > 0:
                    lap_time = e['time_s'] - lap_starts[i-1]['time_s']
                    print(f"    Lap {i}: {lap_time:.3f}s "
                          f"(S/F at {e['time_s']:.3f}s)")
                else:
                    print(f"    First S/F crossing at {e['time_s']:.3f}s")

    if not all_records:
        print("Warning: No telemetry records decoded!", file=sys.stderr)
        return all_records

    # Summary statistics
    speeds = [r['speed_kph'] for r in all_records if r.get('speed_kph', 0) > 0]
    lats = [r['latitude_deg'] for r in all_records if abs(r.get('latitude_deg', 0)) > 1]
    rpms = [r.get('engine_rpm', 0) for r in all_records if r.get('engine_rpm', 0) > 0]

    if speeds:
        print(f"Speed: max {max(speeds):.1f} kph ({max(speeds)/1.609:.1f} mph), "
              f"avg {sum(speeds)/len(speeds):.1f} kph")
    if rpms:
        print(f"RPM: max {max(rpms):.0f}, avg {sum(rpms)/len(rpms):.0f}")
    if lats:
        print(f"GPS: {min(lats):.6f} to {max(lats):.6f}deg")

    # Write CSV
    if csv_path:
        write_csv(all_records, csv_path)
        print(f"CSV written to: {csv_path}")

        # Write events CSV if any events found
        if all_events:
            events_csv_path = str(Path(csv_path).with_name(
                Path(csv_path).stem + '_events.csv'))
            write_events_csv(all_events, events_csv_path)
            print(f"Events CSV written to: {events_csv_path}")

    return all_records


def write_csv(records, csv_path):
    """Write decoded records to CSV."""
    if not records:
        return

    columns = [
        # Timing
        'time_s', 'packet_idx', 'frame_idx',
        # GPS (10 Hz)
        'latitude_deg', 'longitude_deg', 'altitude_m',
        'speed_kph', 'speed_mph', 'speed_mps',
        'heading_deg', 'gps_fix_quality', 'gps_satellites',
        # 10 Hz vehicle
        'throttle_position', 'abs_status', 'abs_status_label',
        'boost_pressure_kpa', 'engine_power_kw', 'emotor_power_kw',
        # 100 Hz (averaged per 10 Hz period)
        'brake_position', 'engine_rpm', 'engine_torque_nm',
        'steering_angle_deg', 'gyro_yaw_deg_s',
        'wheel_speed_fl_kph', 'wheel_speed_fr_kph',
        'wheel_speed_rl_kph', 'wheel_speed_rr_kph',
        # 50 Hz accelerometer (averaged)
        'accel_lateral_g', 'accel_longitudinal_g', 'accel_vertical_g',
        # 5 Hz
        'gear', 'gear_label',
        'engine_startstop', 'engine_startstop_label',
        'esc_status', 'esc_status_label',
        'tcs_status', 'tcs_status_label',
        # 2 Hz
        'oil_pressure_kpa',
        # 1 Hz — engine / environment
        'engine_temp_coolant_c', 'engine_temp_oil_c', 'engine_temp_airintake_c',
        'outside_air_temp_c', 'trans_oil_temp_c',
        'fuel_level_pct', 'odometer_km',
        # 1 Hz — tires
        'tire_pressure_fl_kpa', 'tire_pressure_fr_kpa',
        'tire_pressure_rl_kpa', 'tire_pressure_rr_kpa',
        'tire_temp_fl_c', 'tire_temp_fr_c',
        'tire_temp_rl_c', 'tire_temp_rr_c',
        # 1 Hz — status / hybrid
        'drive_mode', 'drive_mode_label',
        'ptm_mode', 'ptm_mode_label',
        'vse_status', 'vse_status_label',
        'emotor_axle_available', 'emotor_axle_available_label',
        'engine_powerlevel', 'emotor_powerlevel',
        'hv_battery_charge',
    ]

    with open(csv_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for record in records:
            writer.writerow(record)


def write_events_csv(events, csv_path):
    """Write embedded events to a separate CSV file."""
    if not events:
        return

    columns = ['time_s', 'event_id', 'event_name', 'flags']

    with open(csv_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for event in events:
            writer.writerow(event)


# =============================================================================
# Direct Raw File Decoder (for pre-extracted telemetry_raw.bin)
# =============================================================================

def find_raw_packet_boundaries(data):
    """Find data packet boundaries in raw telemetry data.

    Each data packet starts with a 14-byte preamble containing:
      4 zero bytes + u32 BE timestamp + u8 flags + 3 pad bytes + u16 BE 0x0CA1

    The combination of 4 zero bytes at offset 0 and 0x0CA1 at offset 12
    is a reliable packet boundary signature.
    """
    boundaries = []
    pos = 0

    while pos + PREAMBLE_SIZE <= len(data):
        if (data[pos:pos+4] == b'\x00\x00\x00\x00' and
                pos + PREAMBLE_SIZE <= len(data) and
                struct.unpack('>H', data[pos+12:pos+14])[0] == FORMAT_IDENTIFIER):
            boundaries.append(pos)
            # Jump ahead past minimum packet size to avoid false matches
            pos += 3200
        else:
            pos += 1

    return boundaries


def decode_raw_file(raw_path, csv_path=None, verbose=False):
    """Decode a pre-extracted raw telemetry file.

    Handles variable-size packets (oversized packets with embedded events)
    by scanning for preamble signatures instead of assuming uniform sizes.
    """
    with open(raw_path, 'rb') as f:
        data = f.read()

    print(f"Raw file: {len(data)} bytes")

    # Find packet boundaries by preamble scanning
    boundaries = find_raw_packet_boundaries(data)
    if not boundaries:
        print("Error: No valid packet boundaries found", file=sys.stderr)
        return None

    print(f"Found {len(boundaries)} data packets")

    # Compute packet sizes from boundary differences
    packet_sizes = []
    for i in range(len(boundaries)):
        if i + 1 < len(boundaries):
            packet_sizes.append(boundaries[i + 1] - boundaries[i])
        else:
            packet_sizes.append(len(data) - boundaries[i])

    # Determine format variant from dominant packet size
    if packet_sizes:
        # The nominal size is the most common size (events make some larger)
        size_counts = {}
        for s in packet_sizes:
            size_counts[s] = size_counts.get(s, 0) + 1
        dominant_size = max(size_counts, key=size_counts.get)
    else:
        dominant_size = 3247

    hz100_size = 25 if dominant_size > 3500 else 17
    nominal_size = 4050 if hz100_size == 25 else 3247
    lat_offsets = LAT_OFFSETS_V4 if hz100_size == 25 else LAT_OFFSETS_LEGACY
    print(f"Dominant packet size {dominant_size}: using {hz100_size}-byte 100Hz frames")

    if verbose and len(size_counts) > 1:
        print(f"Packet size distribution: {dict(sorted(size_counts.items()))}")
        oversized = sum(1 for s in packet_sizes if s > nominal_size)
        if oversized:
            print(f"  {oversized} oversized packets (contain embedded events)")

    # Decode all packets
    print("Decoding...")
    all_records = []
    all_events = []
    decoded = 0
    failed = 0

    for pkt_idx, pkt_start in enumerate(boundaries):
        pkt_size = packet_sizes[pkt_idx]
        packet = data[pkt_start:pkt_start + pkt_size]

        records = decode_packet(packet, pkt_idx, hz100_size, lat_offsets)
        if records:
            all_records.extend(records)
            decoded += 1
        else:
            failed += 1

        # Extract embedded events
        events = extract_events(packet, nominal_size)
        if events:
            all_events.extend(events)

    print(f"Decoded: {decoded}/{len(boundaries)} packets, {len(all_records)} records")

    if all_events:
        print(f"Embedded events: {len(all_events)}")
        lap_starts = [e for e in all_events if e['event_id'] == 0]
        if lap_starts:
            print(f"  Lap start events: {len(lap_starts)}")
            for i, e in enumerate(lap_starts):
                if i > 0:
                    lap_time = e['time_s'] - lap_starts[i-1]['time_s']
                    print(f"    Lap {i}: {lap_time:.3f}s")

    # Summary
    speeds = [r['speed_kph'] for r in all_records if r.get('speed_kph', 0) > 0]
    rpms = [r.get('engine_rpm', 0) for r in all_records if r.get('engine_rpm', 0) > 0]
    if speeds:
        print(f"Speed: max {max(speeds):.1f} kph ({max(speeds)/1.609:.1f} mph)")
    if rpms:
        print(f"RPM: max {max(rpms):.0f}")

    if csv_path:
        write_csv(all_records, csv_path)
        print(f"CSV written to: {csv_path}")

        if all_events:
            events_csv_path = str(Path(csv_path).with_name(
                Path(csv_path).stem + '_events.csv'))
            write_events_csv(all_events, events_csv_path)
            print(f"Events CSV written to: {events_csv_path}")

    return all_records


# =============================================================================
# Command Line Interface
# =============================================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='AliveDrive PDR 2.5 Telemetry Parser',
        epilog='Extracts telemetry from AliveDrive/Cosworth PDR MP4 files'
    )
    parser.add_argument('input', help='Input MP4 file or raw telemetry file (.bin)')
    parser.add_argument('--csv', '-o', help='Output CSV file path')
    parser.add_argument('--raw', action='store_true',
                       help='Input is a raw telemetry binary (from ffmpeg extraction)')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')

    args = parser.parse_args()

    input_path = Path(args.input)
    csv_path = args.csv
    if csv_path is None:
        csv_path = input_path.with_suffix('.csv')

    if args.raw or input_path.suffix.lower() == '.bin':
        decode_raw_file(str(input_path), str(csv_path),
                       verbose=args.verbose)
    else:
        extract_telemetry(str(input_path), str(csv_path),
                         verbose=args.verbose)


if __name__ == '__main__':
    main()
