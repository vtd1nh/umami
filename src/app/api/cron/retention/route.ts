import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const authorization = request.headers.get('authorization');

  if (
    !process.env.CRON_SECRET ||
    authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  const websiteId = process.env.RETENTION_WEBSITE_ID;

  if (!websiteId) {
    return new Response('RETENTION_WEBSITE_ID is not configured', {
      status: 500,
    });
  }

  const retentionDays = Number.parseInt(process.env.RETENTION_DAYS || '365', 10);

  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    return new Response('RETENTION_DAYS must be a positive integer', {
      status: 500,
    });
  }

  const result = await prisma.transaction(async tx => {
    await tx.$executeRaw`
      CREATE TEMP TABLE retention_old_events ON COMMIT DROP AS
      SELECT event_id
      FROM website_event
      WHERE website_id = ${websiteId}::uuid
        AND created_at < now() - make_interval(days => ${retentionDays})
    `;

    const eventData = await tx.$executeRaw`
      DELETE FROM event_data
      WHERE website_event_id IN (
        SELECT event_id FROM retention_old_events
      )
    `;

    const websiteEvents = await tx.$executeRaw`
      DELETE FROM website_event
      WHERE event_id IN (
        SELECT event_id FROM retention_old_events
      )
    `;

    const sessionData = await tx.$executeRaw`
      DELETE FROM session_data
      WHERE website_id = ${websiteId}::uuid
        AND created_at < now() - make_interval(days => ${retentionDays})
    `;

    await tx.$executeRaw`
      CREATE TEMP TABLE retention_orphan_sessions ON COMMIT DROP AS
      SELECT session_id
      FROM session
      WHERE website_id = ${websiteId}::uuid
        AND created_at < now() - make_interval(days => ${retentionDays})
        AND NOT EXISTS (
          SELECT 1
          FROM website_event
          WHERE website_event.session_id = session.session_id
        )
    `;

    await tx.$executeRaw`
      DELETE FROM revenue
      WHERE website_id = ${websiteId}::uuid
        AND created_at < now() - make_interval(days => ${retentionDays})
    `;

    const sessions = await tx.$executeRaw`
      DELETE FROM session
      WHERE session_id IN (
        SELECT session_id FROM retention_orphan_sessions
      )
    `;

    return {
      eventData,
      websiteEvents,
      sessionData,
      sessions,
    };
  });

  return Response.json({
    ok: true,
    retentionDays,
    deleted: result,
  });
}
