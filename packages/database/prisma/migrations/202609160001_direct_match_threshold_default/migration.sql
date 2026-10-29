-- New stores use 0.6. Existing shops still on the original 0.9 default follow it.
UPDATE "ReplyPolicy" SET "directMatchThreshold" = 0.6 WHERE "directMatchThreshold" = 0.9;
