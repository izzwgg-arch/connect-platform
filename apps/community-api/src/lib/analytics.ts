import type { Db } from "../db.js";

/**
 * The event catalog (brief §27). Adding an event = adding it here so the
 * analytics rollup and the dashboards know it exists.
 */
export const ANALYTICS_EVENTS = [
  "feed_view", "post_impression", "post_open", "profile_view", "company_view", "search", "search_result_click",
  "connection_request", "connection_accept", "follow", "unfollow", "reaction", "comment", "share", "save", "hide", "report",
  "message_started", "message_replied", "call_started", "call_completed", "job_view", "job_apply", "rfq_created",
  "quote_submitted", "quote_accepted", "company_follow", "event_view", "event_rsvp", "marketplace_view", "opportunity_view",
  "signup", "login", "logout", "group_join", "intro_requested", "listing_view", "notification_open",
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export type TrackInput = {
  personId?: string | null;
  sessionId?: string | null;
  event: AnalyticsEventName;
  objectType?: string | null;
  objectId?: string | null;
  client?: string | null;
  appVersion?: string | null;
  surface?: string | null;
  position?: number | null;
  recommendationId?: string | null;
  experimentId?: string | null;
  props?: Record<string, unknown> | null;
};

const FORBIDDEN_PROPS = /password|secret|token|card|ssn|body|message/i;

/** Never logs message bodies, secrets or payment data — props keys are screened. */
export async function track(db: Db, input: TrackInput) {
  const props = input.props
    ? Object.fromEntries(Object.entries(input.props).filter(([k]) => !FORBIDDEN_PROPS.test(k)))
    : undefined;
  await db.analyticsEvent
    .create({
      data: {
        personId: input.personId ?? null,
        sessionId: input.sessionId ?? null,
        event: input.event,
        objectType: input.objectType ?? null,
        objectId: input.objectId ?? null,
        client: input.client ?? null,
        appVersion: input.appVersion ?? null,
        surface: input.surface ?? null,
        position: input.position ?? null,
        recommendationId: input.recommendationId ?? null,
        experimentId: input.experimentId ?? null,
        props: props as object | undefined,
      },
    })
    .catch(() => {
      /* analytics must never fail a request */
    });
}
