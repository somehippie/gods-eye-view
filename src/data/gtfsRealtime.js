/**
 * @module gtfsRealtime
 * @description A minimal, schema-free GTFS-Realtime reader for the fields this
 * app actually renders.
 *
 * NO NEW DEPENDENCY, AND NO .proto. The official `gtfs-realtime-bindings`
 * package carries the full schema — TripUpdate, Alert, shapes, fare products —
 * to read the seven fields a moving dot needs. Protobuf's wire format is
 * self-describing enough to walk without a schema (every field announces its
 * number and wire type), so this reads the tag stream directly and names only
 * the fields it wants. `pbf` is already a dependency for TomTom's MVT tiles,
 * but it wants a generated reader per message type, which is the same schema
 * problem in a different shape.
 *
 * The field numbers below are from the GTFS-Realtime spec and were each
 * confirmed against live 511.org and api.bart.gov payloads. Two are easy to get
 * wrong and were: VehiclePosition #4 is `current_status`, NOT the timestamp
 * (#5 is), and TripDescriptor's `route_id` is #5, not #2.
 */

/** Protobuf wire types. 3 and 4 are the deprecated group markers. */
const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

/** `VehicleStopStatus`, in enum order. */
const STOP_STATUS = Object.freeze(['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO']);

/**
 * Agencies whose vehicles are trains.
 *
 * 511 publishes 43 operators and ~2,000 vehicles at rush hour; all but ~40 of
 * them are buses, which bury the map. These are the 511 operator ids for the
 * rail services, which is the cohort that reads like the ADS-B layer this sits
 * beside.
 *
 * FERRIES ARE DELIBERATELY ABSENT. SF Bay Ferry (SB) publishes 15 boats and
 * every one of them also broadcasts AIS, so carrying them here drew each boat
 * twice — two independent icons stacked at one position, because nothing
 * dedupes between this layer and the AIS one. AIS is the better maritime
 * source and owns the water; rail is the part it cannot show. Golden Gate (GF)
 * and Treasure Island (TF) publish no vehicles at all.
 *
 * BART is absent for a different reason: it publishes no vehicle positions at
 * all, on 511 or on api.bart.gov.
 */
export const RAIL_AGENCIES = Object.freeze({
  CT: { name: 'Caltrain' },
  AM: { name: 'Capitol Corridor' },
  CE: { name: 'ACE' },
  SA: { name: 'SMART' },
});

/**
 * Read one base-128 varint.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[bigint, number]} Value and the offset just past it.
 */
function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index];
    index += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, index];
    shift += 7n;
    // A varint longer than 10 bytes cannot be a valid 64-bit value.
    if (shift > 63n) break;
  }
  throw new RangeError('truncated varint');
}

/**
 * Walk one protobuf message into `[fieldNumber, value]` pairs.
 *
 * Repeated fields appear once per occurrence, in order, which is what the
 * caller wants for `entity`.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<[number, bigint|number|Uint8Array]>}
 */
export function readMessage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let index = 0;
  while (index < bytes.length) {
    const [key, afterKey] = readVarint(bytes, index);
    const fieldNumber = Number(key >> 3n);
    const wireType = Number(key & 7n);
    index = afterKey;
    if (wireType === WIRE_VARINT) {
      const [value, next] = readVarint(bytes, index);
      out.push([fieldNumber, value]);
      index = next;
    } else if (wireType === WIRE_LENGTH) {
      const [length, next] = readVarint(bytes, index);
      const end = next + Number(length);
      if (end > bytes.length) throw new RangeError('truncated length-delimited field');
      out.push([fieldNumber, bytes.subarray(next, end)]);
      index = end;
    } else if (wireType === WIRE_FIXED32) {
      if (index + 4 > bytes.length) throw new RangeError('truncated fixed32');
      out.push([fieldNumber, view.getFloat32(index, true)]);
      index += 4;
    } else if (wireType === WIRE_FIXED64) {
      if (index + 8 > bytes.length) throw new RangeError('truncated fixed64');
      out.push([fieldNumber, view.getFloat64(index, true)]);
      index += 8;
    } else {
      // Deprecated groups (3/4) and anything unknown: the rest of the message
      // can no longer be located, so stop rather than emit garbage.
      throw new RangeError(`unsupported wire type ${wireType}`);
    }
  }
  return out;
}

const first = (message, fieldNumber) => message.find((f) => f[0] === fieldNumber)?.[1];
const every = (message, fieldNumber) => message.filter((f) => f[0] === fieldNumber).map((f) => f[1]);
const asText = (value) => (value instanceof Uint8Array ? new TextDecoder().decode(value) : null);
const asNumber = (value) => {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : null;
};
const sub = (value) => (value instanceof Uint8Array ? readMessage(value) : null);

/**
 * The 511 operator id a vehicle belongs to.
 *
 * The combined regional feed prefixes route and trip ids (`CT:123`) but NOT
 * vehicle ids, so this prefix is the only agency marker on a vehicle. In a
 * single-agency feed nothing is prefixed at all, which is why the caller
 * passes `fallbackAgency` — it knows which feed it asked for.
 *
 * @param {{routeId: string|null, tripId: string|null}} ids
 * @param {string|null} [fallbackAgency]
 * @returns {string|null}
 */
export function agencyOf({ routeId, tripId }, fallbackAgency = null) {
  for (const value of [routeId, tripId]) {
    if (typeof value === 'string' && value.includes(':')) return value.slice(0, value.indexOf(':'));
  }
  return fallbackAgency;
}

/**
 * Strip a `CT:` style agency prefix so ids match the static GTFS.
 * @param {string|null} value
 * @returns {string|null}
 */
const unprefixed = (value) => {
  if (typeof value !== 'string') return null;
  return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
};

/**
 * Decode a GTFS-Realtime `FeedMessage` into the vehicles it carries.
 *
 * Returns `vehicles: []` rather than throwing for a feed that is merely empty —
 * BART's VehiclePositions feed is a valid 15-byte header and nothing else, and
 * that is a data fact, not an error.
 *
 * @param {Uint8Array|Buffer} bytes Raw protobuf response body.
 * @param {object} [options]
 * @param {string|null} [options.fallbackAgency] Operator id when the feed is
 *   single-agency and therefore carries no prefixes.
 * @returns {{timestamp: number|null, entityCount: number, vehicles: Array<object>}}
 */
export function decodeVehiclePositions(bytes, { fallbackAgency = null } = {}) {
  const feed = readMessage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const header = sub(first(feed, 1));
  const timestamp = header ? asNumber(first(header, 3)) : null;
  const entities = every(feed, 2);
  const vehicles = [];

  for (const entityBytes of entities) {
    const entity = sub(entityBytes);
    if (!entity) continue;
    const position = sub(first(entity, 4));
    // TripUpdate-only and Alert-only entities are normal in a mixed feed.
    if (!position) continue;

    const point = sub(first(position, 2));
    const latitude = point ? asNumber(first(point, 1)) : null;
    const longitude = point ? asNumber(first(point, 2)) : null;
    // A vehicle without a position cannot be drawn, and a (0,0) fix is the
    // classic uninitialised GPS report, not a boat in the Gulf of Guinea.
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude === 0 && longitude === 0) continue;

    const trip = sub(first(position, 1)) || [];
    const descriptor = sub(first(position, 8)) || [];
    const routeId = asText(first(trip, 5));
    const tripId = asText(first(trip, 1));
    const vehicleId = asText(first(descriptor, 1));
    const agency = agencyOf({ routeId, tripId }, fallbackAgency);

    vehicles.push({
      // Measured: bare vehicle ids collide across operators in the combined
      // feed (1,926 distinct for 2,043 vehicles), which teleports a dot between
      // two different agencies' vehicles on consecutive polls. Agency + vehicle
      // id is the key that holds.
      id: agency && vehicleId ? `${agency}:${vehicleId}` : (vehicleId ?? null),
      agency,
      vehicleId,
      label: asText(first(descriptor, 2)) || null,
      routeId: unprefixed(routeId),
      tripId: unprefixed(tripId),
      latitude,
      longitude,
      bearing: point ? asNumber(first(point, 3)) : null,
      speed: point ? asNumber(first(point, 5)) : null,
      status: STOP_STATUS[Number(first(position, 4) ?? -1)] ?? null,
      stopId: unprefixed(asText(first(position, 7))),
      timestamp: asNumber(first(position, 5)),
    });
  }

  return { timestamp, entityCount: entities.length, vehicles };
}

/**
 * Keep only the trains, tagged with a display name.
 * @param {Array<object>} vehicles
 * @returns {Array<object>}
 */
export function railOnly(vehicles) {
  const out = [];
  for (const vehicle of vehicles) {
    const meta = RAIL_AGENCIES[vehicle.agency];
    if (!meta) continue;
    out.push({ ...vehicle, agencyName: meta.name });
  }
  return out;
}
