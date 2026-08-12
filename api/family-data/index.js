// Trackline family-data API
// GET  /api/family-data?familyId=xxx   -> returns the saved family JSON blob, or null
// POST /api/family-data  { familyId, data }  -> upserts the family JSON blob
//
// Reads the Cosmos DB connection string from the COSMOS_CONNECTION_STRING app setting.
// Never put the connection string in frontend code — it stays server-side here.

const { CosmosClient } = require("@azure/cosmos");

const DB_NAME = "trackline";
const CONTAINER_NAME = "families";

let containerPromise = null;

async function getContainer() {
  if (containerPromise) return containerPromise;

  containerPromise = (async () => {
    const connectionString = process.env.COSMOS_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error("COSMOS_CONNECTION_STRING app setting is not configured.");
    }
    const client = new CosmosClient(connectionString);

    // Auto-create the database/container on first run if they don't exist yet —
    // convenient for getting started on the free tier without a separate setup step.
    const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
    const { container } = await database.containers.createIfNotExists({
      id: CONTAINER_NAME,
      partitionKey: { paths: ["/familyId"] },
    });
    return container;
  })();

  return containerPromise;
}

module.exports = async function (context, req) {
  try {
    const container = await getContainer();

    if (req.method === "GET") {
      const familyId = (req.query && req.query.familyId) || "";
      if (!familyId) {
        context.res = { status: 400, jsonBody: { error: "familyId is required" } };
        return;
      }
      try {
        const { resource } = await container.item(familyId, familyId).read();
        context.res = { status: 200, jsonBody: resource ? resource.data : null };
      } catch (err) {
        if (err.code === 404) {
          context.res = { status: 200, jsonBody: null };
        } else {
          throw err;
        }
      }
      return;
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const familyId = body.familyId;
      const data = body.data;
      if (!familyId || !data) {
        context.res = { status: 400, jsonBody: { error: "familyId and data are required" } };
        return;
      }
      await container.items.upsert({
        id: familyId,
        familyId: familyId,
        data: data,
        updatedAt: new Date().toISOString(),
      });
      context.res = { status: 200, jsonBody: { ok: true } };
      return;
    }

    context.res = { status: 405, jsonBody: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error("family-data function error:", err);
    context.res = { status: 500, jsonBody: { error: "Server error" } };
  }
};
