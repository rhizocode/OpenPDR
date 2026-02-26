#!/usr/bin/env python3
"""
AliveDrive PDR 2.5 Telemetry Parser
Decodes telemetry data from AliveDrive/Cosworth PDR MP4 files (Cadillac CT5, etc.)

Reverse-engineered from the 'adco' data track format.
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
HEADING_SCALE = 1.745329252e-07  # rad per raw unit (ch 4, i32 — 100× GPS scale)
HEADING_DEG_SCALE = HEADING_SCALE * 180.0 / math.pi

# Wheel speed uses a DIFFERENT angular velocity scale from engine speed
WHEEL_SPEED_SCALE = 0.0251327412  # rad/s per raw unit (ch 54-57)
# Effective tire rolling radius for CT5-V Blackwing 245/35R19 (compressed)
TIRE_RADIUS_M = 0.321  # best-fit vs GPS; nominal geometric = 0.337 m

# Engine torque encoding (confirmed from adcp: scale=0.5, offset=-848)
TORQUE_SCALE = 0.5  # N·m per raw unit
TORQUE_OFFSET = -848.0  # N·m offset (zero torque at raw=1696)

# Brake / throttle position
PROPORTION_SCALE = 1.0 / 255.0  # 0.00392157, maps 0–255 to 0.0–1.0

# Temperature encoding: temp_C = raw * scale + kelvin_offset - 273.15
TEMP_KELVIN_OFFSET = 233.15  # engine/trans/ambient temps → raw*scale - 40
TIRE_TEMP_KELVIN_OFFSET = 253.15  # tire temps → raw*scale - 20

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
    # First, find the moov box
    moov = find_box(mp4_data, 'moov')
    if not moov:
        print("Error: Could not find moov box", file=sys.stderr)
        return None

    moov_offset, moov_size, moov_data = moov
    moov_end = moov_offset + moov_size

    # Find all trak boxes within moov
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

            # Search recursively for hdlr within this trak
            hdlr_results = find_all_boxes(mp4_data, 'hdlr', trak_data, trak_end)
            for h_off, h_size, h_data in hdlr_results:
                if h_data + 12 <= h_off + h_size:
                    # hdlr box: version(4) + predefined(4) + handler_type(4)
                    handler_type = mp4_data[h_data+8:h_data+12].decode('ascii', errors='replace')
                    if handler_type == 'adrv':
                        return trak_offset, trak_size, trak_data, trak_end

            # Also check for 'adco' codec in stsd
            stsd_results = find_all_boxes(mp4_data, 'stsd', trak_data, trak_end)
            for s_off, s_size, s_data in stsd_results:
                # Check if stsd contains adco entry
                if s_data + 16 <= s_off + s_size:
                    entry_start = s_data + 8  # skip version + count
                    if entry_start + 8 <= s_off + s_size:
                        codec_type = mp4_data[entry_start+4:entry_start+8].decode('ascii', errors='replace')
                        if codec_type == 'adco':
                            return trak_offset, trak_size, trak_data, trak_end

        pos += size

    return None


def parse_adcp(data):
    """Parse channel definitions from the adcp box.

    Returns the authoritative channel name map recovered from the Cosworth
    namespace strings embedded in the adcp box.
    """
    # Authoritative channel definitions from adcp box (com.cosworth.channel.*)
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


def parse_adcr(data):
    """Parse the rate table from the adcr box payload.

    In version 1, the first group uses 3 padding bytes before its period field,
    but subsequent groups use 4 padding bytes.
    """
    offset = 0
    # Header: version(1) + flags(1) + num_groups(1) + pad(1)
    version = data[0]
    num_groups = data[2]
    offset = 4

    groups = []
    for g in range(num_groups):
        # Version 1: first group has 3 pad bytes, subsequent have 4
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
# Sample Table Parser (stts, stsc, stsz, stco/co64)
# =============================================================================

def parse_sample_table(mp4_data, trak_data, trak_end):
    """Parse sample table entries to locate telemetry samples."""
    # Find stbl (sample table box)
    stbl = find_box(mp4_data, 'stbl', trak_data, trak_end)
    if not stbl:
        # Try deeper path: mdia/minf/stbl
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
    # stsz: version(4) + sample_size(4) + count(4) + [sizes...]
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
        chunk_num = chunk_idx + 1  # 1-based
        # Find applicable stsc entry
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
# Telemetry Decoder
# =============================================================================

def find_gps_offsets(packet, packet_size=3247):
    """Find the 10 GPS lat offsets within a packet by searching for valid coords."""
    gps_offsets = []
    for off in range(0, packet_size - 8):
        # Check for lat pattern (Spring Mountain area: ~36.17°)
        if len(packet) > off + 8:
            lat_raw = struct.unpack('>i', packet[off:off+4])[0]
            lon_raw = struct.unpack('>i', packet[off+4:off+8])[0]
            lat_deg = lat_raw * DEG_SCALE
            lon_deg = lon_raw * DEG_SCALE
            # Wide range for general GPS validity
            if -90 < lat_deg < 90 and -180 < lon_deg < 180 and abs(lat_deg) > 1.0:
                # Additional check: next few bytes should look like altitude
                if off + 12 <= len(packet):
                    alt_raw = struct.unpack('>I', packet[off+8:off+12])[0]
                    alt_m = alt_raw * ALT_SCALE
                    if -1000 < alt_m < 10000:
                        gps_offsets.append(off)

    # Filter to keep only the 10 most likely GPS offsets (evenly spaced)
    if len(gps_offsets) < 10:
        return gps_offsets

    # Use clustering to find the 10 real GPS positions
    # They should be roughly evenly spaced (~320 bytes apart)
    filtered = [gps_offsets[0]]
    for off in gps_offsets[1:]:
        if off - filtered[-1] > 200:  # minimum gap between GPS readings
            filtered.append(off)
        if len(filtered) >= 10:
            break

    return filtered


def find_float_blocks(packet, packet_size=3247):
    """Find all 50Hz float blocks (6 × float32 accelerometer data)."""
    float_offsets = []
    for start in range(0, packet_size - 24):
        valid = True
        for j in range(6):
            if start + j*4 + 4 > len(packet):
                valid = False
                break
            fval = struct.unpack('>f', packet[start+j*4:start+j*4+4])[0]
            if abs(fval) > 5.0 or (abs(fval) < 1e-10 and fval != 0.0):
                valid = False
                break
        if valid:
            # Check at least 2 non-trivial values
            floats = [struct.unpack('>f', packet[start+j*4:start+j*4+4])[0] for j in range(6)]
            nonzero = sum(1 for f in floats if abs(f) > 0.001)
            if nonzero >= 2:
                if not float_offsets or start - float_offsets[-1] >= 20:
                    float_offsets.append(start)

    return float_offsets


def decode_100hz_frame(packet, offset):
    """Decode a 100Hz sub-frame (17 bytes).

    Layout: brake(1) engine_speed(2) torque(2) steering(2)
            wheel_FL(2) wheel_FR(2) wheel_RL(2) wheel_RR(2) gyro_yaw(2)
    """
    if offset < 0 or offset + 17 > len(packet):
        return None

    frame = packet[offset:offset+17]
    if len(frame) < 17:
        return None

    torque_raw = struct.unpack('>H', frame[3:5])[0]
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
    """Decode a 50Hz sub-frame (24 bytes = 6 × float32).

    Two independent 3-axis accelerometer readings in g:
    - Device (ch 8-10): raw sensor frame (tilted ~17° from vehicle vertical)
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
    alt_raw = struct.unpack('>I', packet[lat_offset+8:lat_offset+12])[0]
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
        'throttle_position': throttle_raw * PROPORTION_SCALE,
        'boost_pressure_kpa': boost_raw * BOOST_PRESSURE_SCALE / 1000.0,
        'emotor_power_kw': emotor_raw * POWER_SCALE / 1000.0,
        'engine_power_kw': engine_raw * POWER_SCALE / 1000.0,
    }


def decode_5hz_frame(packet, offset):
    """Decode 5Hz data (4 bytes): gear, startstop, ESC, TCS."""
    if offset + 4 > len(packet):
        return None
    return {
        'gear': packet[offset],
        'engine_startstop': packet[offset+1],
        'esc_status': packet[offset+2],
        'tcs_status': packet[offset+3],
    }


def decode_1hz_frame(packet, lat_offset):
    """Decode the full 1 Hz frame (31 bytes, 27 channels).

    The 1 Hz block starts after the 10 Hz frame (26 bytes), 5 Hz frame (4 bytes),
    and 2 Hz frame (1 byte) in frame 0: lat_offset + 26 + 4 + 1 = lat_offset + 31.
    """
    hz1_offset = lat_offset + 26 + 4 + 1  # after group2 + group3 + group4
    if hz1_offset + 31 > len(packet):
        return None

    b = packet[hz1_offset:hz1_offset + 31]
    odometer_raw = struct.unpack('>I', b[16:20])[0]
    hv_charge_raw = struct.unpack('>H', b[1:3])[0]

    return {
        'emotor_powerlevel': b[0] * 0.01,
        'hv_battery_charge': hv_charge_raw * 1.5259e-5,
        'drive_mode': b[3],
        'emotor_axle_available': b[4],
        'emotor_temp_rotor_c': b[5] - 40 if b[5] > 0 else None,
        'emotor_temp_stator_c': b[6] - 40 if b[6] > 0 else None,
        'engine_temp_coolant_c': b[7] - 40,
        'engine_temp_airintake_c': b[8] - 40,
        'engine_temp_oil_c': b[9] - 40,
        'engine_powerlevel': b[10] * 0.01,
        'outside_air_temp_c': b[11] * 0.5 - 40,
        'fuel_level_pct': b[12] * FUEL_LEVEL_SCALE * 100.0,
        'hv_battery_temp_avg_c': b[13] - 40 if b[13] > 0 else None,
        'hv_battery_temp_max_c': b[14] * 0.5 - 40 if b[14] > 0 else None,
        'hv_battery_temp_min_c': b[15] * 0.5 - 40 if b[15] > 0 else None,
        'odometer_km': odometer_raw * ODOMETER_SCALE / 1000.0,
        'ptm_mode': b[20],
        'trans_oil_temp_c': b[21] - 40,
        'tire_pressure_fl_kpa': b[22] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_pressure_fr_kpa': b[23] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_pressure_rl_kpa': b[24] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_pressure_rr_kpa': b[25] * TIRE_PRESSURE_SCALE / 1000.0,
        'tire_temp_fl_c': b[26] - 20,
        'tire_temp_fr_c': b[27] - 20,
        'tire_temp_rl_c': b[28] - 20,
        'tire_temp_rr_c': b[29] - 20,
        'vse_status': b[30],
    }


def decode_packet(packet, packet_idx, reference_lat_range=None):
    """
    Decode a complete telemetry packet.

    Returns a list of decoded records at various rates.
    """
    PACKET_SIZE = len(packet)
    if PACKET_SIZE < 100:
        return []  # Skip init packet

    # Find GPS offsets by searching for valid coordinate patterns
    gps_offsets = find_gps_in_packet(packet, reference_lat_range)

    if len(gps_offsets) < 5:
        # Can't decode this packet reliably
        return []

    # Find float blocks (50Hz accelerometer data)
    float_offsets = find_float_blocks(packet, PACKET_SIZE)

    records = []
    base_time = packet_idx  # seconds

    for frame_idx, lat_off in enumerate(gps_offsets):
        frame_time = base_time + frame_idx * 0.1  # 10Hz = 100ms intervals

        # Decode 10Hz data
        g2 = decode_10hz_frame(packet, lat_off)
        if g2 is None:
            continue

        # Find the float blocks and 100Hz frames for this 10Hz period
        next_lat = gps_offsets[frame_idx + 1] if frame_idx < len(gps_offsets) - 1 else PACKET_SIZE
        frame_floats = [f for f in float_offsets if lat_off < f < next_lat]

        # Decode 100Hz sub-frames (between group2 end and next lat)
        # Group 2 without speed = 26 bytes. Plus variable low-rate data.
        # 100Hz frames are 34 bytes before each float block (2 × 17)
        hz100_frames = []
        for fidx, foff in enumerate(frame_floats):
            # Two 100Hz frames before each float
            f1_off = foff - 34
            f2_off = foff - 17
            if f1_off >= lat_off:
                f1 = decode_100hz_frame(packet, f1_off)
                if f1:
                    hz100_frames.append(f1)
            f2 = decode_100hz_frame(packet, f2_off)
            if f2:
                hz100_frames.append(f2)

        # Decode 50Hz sub-frames
        hz50_frames = []
        for foff in frame_floats:
            f = decode_50hz_frame(packet, foff)
            if f:
                hz50_frames.append(f)

        # Determine 5Hz data (in even frames: 0, 2, 4, 6, 8)
        has_5hz = (frame_idx % 2 == 0)
        hz5_data = None
        if has_5hz:
            # 5Hz data starts at lat + 26 (after base group 2)
            hz5_offset = lat_off + 26
            hz5_data = decode_5hz_frame(packet, hz5_offset)

        # 2Hz oil pressure (in frames 0 and 5)
        oil_pressure_kpa = None
        if frame_idx in (0, 5):
            # 2Hz data is after group2 (26 bytes) + group3 if present (4 bytes)
            hz2_offset = lat_off + 26
            if has_5hz:
                hz2_offset += 4  # after 5Hz block
            if hz2_offset < len(packet):
                oil_pressure_kpa = packet[hz2_offset] * OIL_PRESSURE_SCALE / 1000.0

        # Build the record
        record = {
            'packet_idx': packet_idx,
            'frame_idx': frame_idx,
            'time_s': frame_time,
        }
        record.update(g2)

        # Add averaged 100Hz data for this period
        if hz100_frames:
            n = len(hz100_frames)
            record['brake_position'] = sum(f['brake_position'] for f in hz100_frames) / n
            record['engine_rpm'] = sum(f['engine_rpm'] for f in hz100_frames) / n
            record['engine_torque_nm'] = sum(f['engine_torque_nm'] for f in hz100_frames) / n
            record['steering_angle_deg'] = sum(f['steering_angle_deg'] for f in hz100_frames) / n
            record['wheel_speed_fl_kph'] = sum(f['wheel_speed_fl_kph'] for f in hz100_frames) / n
            record['wheel_speed_fr_kph'] = sum(f['wheel_speed_fr_kph'] for f in hz100_frames) / n
            record['wheel_speed_rl_kph'] = sum(f['wheel_speed_rl_kph'] for f in hz100_frames) / n
            record['wheel_speed_rr_kph'] = sum(f['wheel_speed_rr_kph'] for f in hz100_frames) / n
            record['gyro_yaw_deg_s'] = sum(f['gyro_yaw_deg_s'] for f in hz100_frames) / n

        # Add averaged 50Hz data (gravity-compensated vehicle-frame values)
        if hz50_frames:
            n = len(hz50_frames)
            record['accel_lateral_g'] = sum(f['accel_vehicle_x_g'] for f in hz50_frames) / n
            record['accel_longitudinal_g'] = sum(f['accel_vehicle_y_g'] for f in hz50_frames) / n
            record['accel_vertical_g'] = sum(f['accel_vehicle_z_g'] for f in hz50_frames) / n

        # Add 5Hz data
        if hz5_data:
            record['gear'] = hz5_data['gear']
            record['esc_status'] = hz5_data['esc_status']
            record['tcs_status'] = hz5_data['tcs_status']

        # Add 2Hz data
        if oil_pressure_kpa is not None:
            record['oil_pressure_kpa'] = oil_pressure_kpa

        # Add 1Hz data (only in frame 0)
        if frame_idx == 0:
            hz1_data = decode_1hz_frame(packet, lat_off)
            if hz1_data:
                record.update(hz1_data)

        records.append(record)

    return records


def find_gps_in_packet(packet, reference_lat_range=None):
    """
    Find GPS lat positions in a packet.
    Uses reference lat/lon range if available, otherwise searches broadly.
    """
    PACKET_SIZE = len(packet)
    candidates = []

    for off in range(0, PACKET_SIZE - 12):
        lat_raw = struct.unpack('>i', packet[off:off+4])[0]
        lon_raw = struct.unpack('>i', packet[off+4:off+8])[0]
        alt_raw = struct.unpack('>I', packet[off+8:off+12])[0]

        lat_deg = lat_raw * DEG_SCALE
        lon_deg = lon_raw * DEG_SCALE
        alt_m = alt_raw * ALT_SCALE

        if reference_lat_range:
            lat_min, lat_max, lon_min, lon_max = reference_lat_range
            if lat_min <= lat_deg <= lat_max and lon_min <= lon_deg <= lon_max and 0 < alt_m < 10000:
                candidates.append(off)
        else:
            # Strict search: require plausible lat AND lon AND altitude
            if (10.0 < abs(lat_deg) < 80.0 and
                10.0 < abs(lon_deg) < 180.0 and
                0 < alt_m < 10000):
                candidates.append(off)

    # Filter to evenly-spaced positions (expecting ~300-360 byte gaps)
    if len(candidates) < 2:
        return candidates

    filtered = [candidates[0]]
    for off in candidates[1:]:
        if off - filtered[-1] >= 250:  # minimum gap between GPS readings
            filtered.append(off)
        if len(filtered) >= 10:
            break

    # Validate: GPS readings should be clustered (all similar lat/lon)
    if len(filtered) >= 3:
        lats = []
        for off in filtered[:5]:
            lat = struct.unpack('>i', packet[off:off+4])[0] * DEG_SCALE
            lats.append(lat)
        # All lats should be within 0.1 degree of each other
        if max(lats) - min(lats) > 0.5:
            return []  # Likely false positives

    return filtered


# =============================================================================
# Outing Properties Parser
# =============================================================================

def parse_adop(data):
    """Parse outing properties from adop box to get reference location."""
    # Search for GPS coordinates in the properties
    # The outing properties contain max/min lat/lon as float64 values
    # This gives us the reference location to search for GPS data in packets

    props = {}
    # Look for recognizable strings and values
    text = data.decode('ascii', errors='replace')

    # Search for lat/lon values stored as 8-byte doubles
    for i in range(0, len(data) - 8):
        try:
            val = struct.unpack('>d', data[i:i+8])[0]
            if 25.0 < val < 50.0:  # Plausible US latitude
                # Check if the next double is a longitude
                if i + 16 <= len(data):
                    val2 = struct.unpack('>d', data[i+8:i+16])[0]
                    if -130.0 < val2 < -60.0:  # Plausible US longitude
                        props['lat'] = val
                        props['lon'] = val2
                        break
        except:
            pass

    return props


# =============================================================================
# Main Extraction Pipeline
# =============================================================================

def extract_telemetry(mp4_path, csv_path=None, verbose=False):
    """
    Extract telemetry from an AliveDrive PDR MP4 file.

    Args:
        mp4_path: Path to the input MP4 file
        csv_path: Optional path for CSV output
        verbose: Print detailed progress info
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
        # Show sample size distribution
        sizes = {}
        for s in sample_sizes:
            sizes[s] = sizes.get(s, 0) + 1
        print(f"Sample sizes: {dict(sorted(sizes.items()))}")

    # Find reference GPS location from outing properties
    adop = find_box(mp4_data, 'adop', 0, len(mp4_data))
    ref_lat_range = None
    if adop:
        adop_data = mp4_data[adop[2]:adop[0]+adop[1]]
        props = parse_adop(adop_data)
        if 'lat' in props:
            lat, lon = props['lat'], props['lon']
            print(f"Reference location: {lat:.4f}°N, {lon:.4f}°W")
            # Create a search window around the reference
            ref_lat_range = (lat - 1.0, lat + 1.0, lon - 1.0, lon + 1.0)

    # If no reference from adop, try to find it from a middle packet
    if ref_lat_range is None:
        print("Searching for GPS reference in data...")
        # Try a packet from the middle of the recording
        mid_idx = len(sample_offsets) // 2
        for try_idx in range(mid_idx, min(mid_idx + 50, len(sample_offsets))):
            off = sample_offsets[try_idx]
            sz = sample_sizes[try_idx]
            packet = mp4_data[off:off+sz]
            if sz > 100:
                gps = find_gps_in_packet(packet)
                if len(gps) >= 5:
                    lat_raw = struct.unpack('>i', packet[gps[0]:gps[0]+4])[0]
                    lon_raw = struct.unpack('>i', packet[gps[0]+4:gps[0]+8])[0]
                    lat = lat_raw * DEG_SCALE
                    lon = lon_raw * DEG_SCALE
                    ref_lat_range = (lat - 1.0, lat + 1.0, lon - 1.0, lon + 1.0)
                    print(f"Found GPS reference: {lat:.4f}°N, {lon:.4f}°W")
                    break

    # Decode all packets
    print("Decoding telemetry packets...")
    all_records = []
    decoded_packets = 0
    failed_packets = 0

    for pkt_idx in range(len(sample_offsets)):
        off = sample_offsets[pkt_idx]
        sz = sample_sizes[pkt_idx]
        packet = mp4_data[off:off+sz]

        if sz < 100:
            continue  # Skip init packet

        records = decode_packet(packet, pkt_idx, ref_lat_range)
        if records:
            all_records.extend(records)
            decoded_packets += 1
        else:
            failed_packets += 1

        if verbose and pkt_idx % 100 == 0:
            print(f"  Processed {pkt_idx}/{len(sample_offsets)} packets ({len(all_records)} records)")

    print(f"Decoded {decoded_packets} packets ({failed_packets} failed)")
    print(f"Total records: {len(all_records)}")

    if not all_records:
        print("Warning: No telemetry records decoded!", file=sys.stderr)
        return all_records

    # Summary statistics
    speeds = [r['speed_kph'] for r in all_records if r.get('speed_kph', 0) > 0]
    lats = [r['latitude_deg'] for r in all_records if abs(r.get('latitude_deg', 0)) > 1]
    rpms = [r.get('engine_rpm', 0) for r in all_records if r.get('engine_rpm', 0) > 0]

    if speeds:
        print(f"Speed: max {max(speeds):.1f} kph ({max(speeds)/1.609:.1f} mph), avg {sum(speeds)/len(speeds):.1f} kph")
    if rpms:
        print(f"RPM: max {max(rpms):.0f}, avg {sum(rpms)/len(rpms):.0f}")
    if lats:
        print(f"GPS: {min(lats):.6f} to {max(lats):.6f}°N")

    # Write CSV
    if csv_path:
        write_csv(all_records, csv_path)
        print(f"CSV written to: {csv_path}")

    return all_records


def write_csv(records, csv_path):
    """Write decoded records to CSV."""
    if not records:
        return

    # Define column order — all decoded fields
    columns = [
        # Timing
        'time_s', 'packet_idx', 'frame_idx',
        # GPS (10 Hz)
        'latitude_deg', 'longitude_deg', 'altitude_m',
        'speed_kph', 'speed_mph', 'speed_mps',
        'heading_deg', 'gps_fix_quality', 'gps_satellites',
        # 10 Hz vehicle
        'throttle_position', 'abs_status',
        'boost_pressure_kpa', 'engine_power_kw', 'emotor_power_kw',
        # 100 Hz (averaged per 10 Hz period)
        'brake_position', 'engine_rpm', 'engine_torque_nm',
        'steering_angle_deg', 'gyro_yaw_deg_s',
        'wheel_speed_fl_kph', 'wheel_speed_fr_kph',
        'wheel_speed_rl_kph', 'wheel_speed_rr_kph',
        # 50 Hz accelerometer (averaged)
        'accel_lateral_g', 'accel_longitudinal_g', 'accel_vertical_g',
        # 5 Hz
        'gear', 'esc_status', 'tcs_status',
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
        'drive_mode', 'ptm_mode', 'vse_status',
        'engine_powerlevel', 'emotor_powerlevel',
        'hv_battery_charge',
    ]

    with open(csv_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for record in records:
            writer.writerow(record)


# =============================================================================
# Direct Raw File Decoder (for pre-extracted telemetry_raw.bin)
# =============================================================================

def decode_raw_file(raw_path, csv_path=None, ref_lat=None, ref_lon=None, verbose=False):
    """
    Decode a pre-extracted raw telemetry file (from ffmpeg -map 0:1 -c copy -f data).
    """
    with open(raw_path, 'rb') as f:
        data = f.read()

    print(f"Raw file: {len(data)} bytes")

    # Detect packet structure
    # First packet is typically 14 bytes (init), rest are uniform size
    INIT_SIZE = 14
    # Find the common packet size
    remaining = len(data) - INIT_SIZE
    # Try common sizes
    for pkt_size in [3247, 3248, 3200, 3000, 2500, 2000]:
        if remaining % pkt_size == 0 or (remaining % pkt_size) < 20:
            num_packets = remaining // pkt_size
            print(f"Detected: {INIT_SIZE}-byte init + {num_packets} × {pkt_size}-byte packets")
            break
    else:
        # Auto-detect: find the second packet boundary
        # Look for repeating patterns
        pkt_size = 3247
        num_packets = remaining // pkt_size
        print(f"Assuming: {INIT_SIZE}-byte init + {num_packets} × {pkt_size}-byte packets")

    # Set up reference GPS range
    ref_lat_range = None
    if ref_lat and ref_lon:
        ref_lat_range = (ref_lat - 1.0, ref_lat + 1.0, ref_lon - 1.0, ref_lon + 1.0)
    else:
        # Try to find reference from multiple packets (scan from middle outward)
        for try_offset in range(0, min(100, num_packets)):
            for direction in [0, 1]:  # try middle, then middle+1, middle-1, ...
                idx = num_packets // 2 + (try_offset if direction == 0 else -try_offset)
                if idx < 0 or idx >= num_packets:
                    continue
                packet = data[INIT_SIZE + idx * pkt_size: INIT_SIZE + (idx+1) * pkt_size]
                gps = find_gps_in_packet(packet)
                if len(gps) >= 5:
                    lat = struct.unpack('>i', packet[gps[0]:gps[0]+4])[0] * DEG_SCALE
                    lon = struct.unpack('>i', packet[gps[0]+4:gps[0]+8])[0] * DEG_SCALE
                    if abs(lat) > 5 and abs(lon) > 5:
                        ref_lat_range = (lat - 0.5, lat + 0.5, lon - 0.5, lon + 0.5)
                        print(f"GPS reference: {lat:.4f}°, {lon:.4f}° (from packet {idx})")
                        break
            if ref_lat_range:
                break
        if not ref_lat_range:
            print("Warning: Could not find GPS reference. Try --lat/--lon options.")

    # Decode all packets
    print("Decoding...")
    all_records = []
    decoded = 0
    failed = 0

    for pkt_idx in range(num_packets):
        pkt_start = INIT_SIZE + pkt_idx * pkt_size
        packet = data[pkt_start:pkt_start + pkt_size]

        records = decode_packet(packet, pkt_idx, ref_lat_range)
        if records:
            all_records.extend(records)
            decoded += 1
        else:
            failed += 1

    print(f"Decoded: {decoded}/{num_packets} packets, {len(all_records)} records")

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
    parser.add_argument('--lat', type=float, help='Reference latitude for GPS search')
    parser.add_argument('--lon', type=float, help='Reference longitude for GPS search')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')

    args = parser.parse_args()

    input_path = Path(args.input)
    csv_path = args.csv
    if csv_path is None:
        csv_path = input_path.with_suffix('.csv')

    if args.raw or input_path.suffix.lower() == '.bin':
        decode_raw_file(str(input_path), str(csv_path),
                       ref_lat=args.lat, ref_lon=args.lon,
                       verbose=args.verbose)
    else:
        extract_telemetry(str(input_path), str(csv_path),
                         verbose=args.verbose)


if __name__ == '__main__':
    main()
