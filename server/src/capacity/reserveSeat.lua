-- classroom-app/server/src/capacity/reserveSeat.lua
--
-- Atomic seat reservation  (F1)  [UNCHANGED]
--
-- Reference implementation; keep yours if it differs.
--
-- Runs inside Redis so that checking the limit and taking the seat are one
-- operation. Done from the application they are two, and two API tasks admitting
-- the last learner at the same moment both see "one seat left" and both let them
-- in — which is how a plan with a 25-seat limit ends up with 27 people in a room.
--
-- Seats are a hash of userId -> expiry rather than a counter. A counter cannot
-- tell a rejoin from a new arrival, and a dropped connection that never released
-- its seat would leak one permanently. Every call prunes what has expired, so a
-- browser that crashed frees its seat within the TTL without anyone acting.
--
-- KEYS[1]  the room's seat hash
-- ARGV[1]  userId
-- ARGV[2]  limit            seats the plan allows
-- ARGV[3]  now              milliseconds
-- ARGV[4]  ttl              milliseconds a seat survives without a heartbeat
--
-- Returns: { granted, occupied, remaining, rejoined }

local key      = KEYS[1]
local user_id  = ARGV[1]
local limit    = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])

-- Prune first. Expired seats are not occupied, and counting them would refuse a
-- learner on behalf of somebody who left an hour ago.
local entries = redis.call('HGETALL', key)
local occupied = 0
local holds_seat = false

for index = 1, #entries, 2 do
  local holder = entries[index]
  local expires_at = tonumber(entries[index + 1])

  if expires_at == nil or expires_at < now then
    redis.call('HDEL', key, holder)
  else
    occupied = occupied + 1
    if holder == user_id then
      holds_seat = true
    end
  end
end

-- A rejoin is not a new seat. Reconnecting after a network blip must not be
-- refused because the seat the client still holds is counted against it.
if holds_seat then
  redis.call('HSET', key, user_id, now + ttl)
  redis.call('PEXPIRE', key, ttl * 3)
  return { 1, occupied, limit - occupied, 1 }
end

if occupied >= limit then
  -- The hash still gets a TTL: a full room that is then abandoned should not
  -- keep its key forever.
  redis.call('PEXPIRE', key, ttl * 3)
  return { 0, occupied, 0, 0 }
end

redis.call('HSET', key, user_id, now + ttl)
-- Three TTLs of slack, so the key outlives the seats inside it and a room with
-- one silent participant is not repeatedly recreated.
redis.call('PEXPIRE', key, ttl * 3)

occupied = occupied + 1
return { 1, occupied, limit - occupied, 0 }