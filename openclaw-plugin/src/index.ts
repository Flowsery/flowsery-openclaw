import { Type, type TObject, type TSchema } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { callApi, readConfig, type PluginConfig } from "./api.js";

const WebsiteSelector = {
  websiteId: Type.Optional(Type.String({ description: "Website id to query." })),
  domain: Type.Optional(Type.String({ description: "Website domain, as an alternative to websiteId." })),
};

const DateRange = {
  startAt: Type.Optional(Type.String({ description: 'ISO 8601 start date, for example "2026-01-01".' })),
  endAt: Type.Optional(Type.String({ description: 'ISO 8601 end date. Omit both for all time.' })),
  timezone: Type.Optional(Type.String({ description: "IANA timezone. Falls back to the site default." })),
};

const Pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Defaults to 100." })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
};

const FILTER_DIMENSIONS = [
  "country", "region", "city", "device", "browser", "os", "referrer", "ref",
  "source", "via", "utm_source", "utm_medium", "utm_campaign", "utm_term",
  "utm_content", "page", "hostname", "entry_page", "channel", "goal",
] as const;

const Filters: Record<string, TSchema> = Object.fromEntries(
  FILTER_DIMENSIONS.map((dimension) => [
    `filter_${dimension}`,
    Type.Optional(Type.String({ description: `Restrict results to one ${dimension.replace(/_/g, " ")} value.` })),
  ]),
);

const BreakdownDimension = Type.Union(
  [
    "device", "page", "entry_page", "exit_link", "hostname", "referrer",
    "channel", "campaign", "goal", "country", "region", "city", "browser",
    "browser_version", "os", "os_version", "utm_source", "utm_medium",
    "utm_campaign", "utm_term", "utm_content", "ref", "source", "all_params",
  ].map((value) => Type.Literal(value)),
  { description: "The dimension to group visitors by." },
);

const query = (extra: Record<string, TSchema> = {}): TObject =>
  Type.Object({ ...WebsiteSelector, ...DateRange, ...Pagination, ...Filters, ...extra });

export default definePluginEntry({
  id: "flowsery",
  name: "Flowsery",
  description:
    "Query privacy-first web analytics: visitors, trends, 24 breakdown dimensions, live visitors, and the issues AI found in session recordings.",
  register(api) {
    const cfg = (): PluginConfig => readConfig(api as { config?: unknown });

    const get = (path: string, params: unknown, signal?: AbortSignal) =>
      callApi(cfg(), "GET", path, { query: params as Record<string, unknown>, signal });

    api.registerTool({
      name: "flowsery_websites",
      label: "Flowsery: list websites",
      description:
        "List the websites this workspace token can read, with their ids and domains. Call this first: every other tool needs a websiteId or domain, and a workspace token does not imply one.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, signal) {
        return jsonResult(await callApi(cfg(), "GET", "/websites", { signal }));
      },
    });

    api.registerTool({
      name: "flowsery_overview",
      label: "Flowsery: site totals",
      description:
        "Aggregated totals for one site: visitors, sessions, bounce rate, average session duration, revenue, revenue per visitor and conversion rate. Omit the dates for all time. Every filter_* argument narrows the whole result, so filter_country plus filter_device answers 'mobile visitors from Germany' in one call.",
      parameters: query({
        fields: Type.Optional(
          Type.String({
            description:
              "Comma-separated subset of visitors, sessions, bounce_rate, avg_session_duration, currency, revenue, revenue_per_visitor, conversion_rate. Omit for all.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(await get("/overview", params, signal));
      },
    });

    api.registerTool({
      name: "flowsery_timeseries",
      label: "Flowsery: trend over time",
      description:
        "The same metrics as flowsery_overview, but bucketed by hour, day, week or month. Use this for anything shaped like a trend or a chart. Asking for hourly buckets across a year returns thousands of points, so match the interval to the range.",
      parameters: query({
        interval: Type.Optional(
          Type.Union(
            [Type.Literal("hour"), Type.Literal("day"), Type.Literal("week"), Type.Literal("month")],
            { description: "Defaults to day." },
          ),
        ),
        fields: Type.Optional(
          Type.String({ description: "Comma-separated: visitors, sessions, revenue, conversion_rate, name." }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(await get("/timeseries", params, signal));
      },
    });

    api.registerTool({
      name: "flowsery_breakdown",
      label: "Flowsery: break down by dimension",
      description:
        "Group visitors by any one of 24 dimensions: top pages, referrers, countries, devices, browsers, campaigns, UTM parameters, exit links and more. This one tool replaces the API's fifteen per-dimension endpoints. Combine a dimension with filter_* arguments to drill in, for example dimension=page with filter_utm_campaign to see where one campaign's traffic landed.",
      parameters: query({ dimension: BreakdownDimension }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(await get("/breakdown", params, signal));
      },
    });

    api.registerTool({
      name: "flowsery_realtime",
      label: "Flowsery: live visitors",
      description:
        "Count the visitors active on the site in the last five minutes. A point-in-time number with no history, so it answers 'is anyone on the site now' and nothing about trends. Use flowsery_timeseries for those.",
      parameters: Type.Object({ ...WebsiteSelector }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(await get("/realtime", params, signal));
      },
    });

    api.registerTool({
      name: "flowsery_issues",
      label: "Flowsery: AI-detected issues",
      description:
        "List the bugs, broken flows and UX problems the AI found while analyzing session recordings, deduplicated across sessions and ranked by severity. Each issue carries how many sessions hit it, when it was first and last seen, and steps to replicate. Also returns open, in-progress and resolved counts. Suspended issues are excluded unless status asks for them.",
      parameters: Type.Object({
        ...WebsiteSelector,
        ...Pagination,
        status: Type.Optional(
          Type.Union(
            [Type.Literal("open"), Type.Literal("in_progress"), Type.Literal("resolved"), Type.Literal("suspended")],
            { description: "Default excludes suspended." },
          ),
        ),
        severity: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("critical"),
          ]),
        ),
        search: Type.Optional(Type.String({ description: "Match against issue title and description." })),
        sort: Type.Optional(
          Type.Union([Type.Literal("severity"), Type.Literal("recency")], {
            description: "Defaults to severity.",
          }),
        ),
      }),
      async execute(_toolCallId, params, signal) {
        return jsonResult(await get("/issues", params, signal));
      },
    });
  },
});
