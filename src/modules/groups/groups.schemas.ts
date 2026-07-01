// Response schemas = OUTPUT ALLOWLISTS (S5).
//
// fastify's serializer (fast-json-stringify) emits ONLY the fields declared
// here. That turns "remember to select carefully" into a structural
// guarantee at the serialization boundary: the next sensitive field added to
// a model (the next sessionToken) is invisible to clients unless someone
// deliberately declares it below.
//
// Every field listed is read by a frontend (audited against public/*.html)
// or is harmless metadata. Vendor objects inside GROUP views deliberately
// exclude gotabLocationId — internal POS mapping, not for diners' browsers.
// (The admin page DOES read gotabLocationId, but from the menu endpoint,
// whose schema lives in vendors.routes.ts.)

const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

// Vendor as seen inside group views: name only (plus id for keying).
const groupVendorSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
  },
} as const;

const orderItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    qty: { type: 'number' },
    notes: { type: ['string', 'null'] },
    status: { type: 'string' },
    priceCentsSnapshot: { type: 'number' },
    prepSecondsSnapshot: { type: 'number' },
    menuItem: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        vendor: groupVendorSchema,
      },
    },
  },
} as const;

const memberSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    displayName: { type: 'string' },
    isHost: { type: 'boolean' },
    payStatus: { type: 'string' },
    createdAt: dateTime,
    orderItems: { type: 'array', items: orderItemSchema },
  },
} as const;

const ticketSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    vendorId: { type: 'string' },
    status: { type: 'string' },
    fireAt: dateTime,
    firedAt: nullableDateTime,
    readyAt: nullableDateTime,
    vendor: groupVendorSchema,
  },
} as const;

const groupViewBodySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    foodHallId: { type: 'string' },
    joinCode: { type: 'string' },
    status: { type: 'string' },
    lockedAt: nullableDateTime,
    targetReadyAt: nullableDateTime,
    createdAt: dateTime,
    members: { type: 'array', items: memberSchema },
    tickets: { type: 'array', items: ticketSchema },
  },
} as const;

// GET /groups/:groupId
export const groupViewRouteSchema = {
  response: { 200: groupViewBodySchema },
} as const;

// GET /halls/:hallId/active-groups (board + admin); active-groups members
// don't include orderItems, but a superset schema is fine — absent fields
// simply serialize as undefined-omitted.
export const activeGroupsRouteSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: groupViewBodySchema },
      },
    },
  },
} as const;

// POST /groups and POST /groups/join — the ONE place a member's own token is
// returned, made explicit by the schema.
export const memberCredentialsResponseSchema = {
  response: {
    201: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        joinCode: { type: 'string' },
        memberToken: { type: 'string' },
        memberId: { type: 'string' },
      },
    },
  },
} as const;
