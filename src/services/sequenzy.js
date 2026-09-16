const SEQUENZY_BASE_URL = 'https://api.sequenzy.com/api/v1';

function isConfigured() {
    return Boolean(process.env.SEQUENZY_API_KEY);
}

async function request(path, body) {
    if (!isConfigured()) return null;

    const response = await fetch(`${SEQUENZY_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.SEQUENZY_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
        throw new Error(`Sequenzy ${response.status}: ${payload.error?.message || payload.error || response.statusText}`);
    }

    return payload;
}

function subscriberIdentity(user) {
    return {
        email: user.email,
        externalId: user.id,
        ...(user.firstName ? { firstName: user.firstName } : {})
    };
}

async function syncSubscriber(user, customAttributes = {}) {
    if (!user?.email || !isConfigured()) return;

    await request('/subscribers', {
        ...subscriberIdentity(user),
        customAttributes,
        duplicateStrategy: 'merge',
        enrollInSequences: false
    });
}

async function trackEvent(user, event, properties = {}, eventId) {
    if (!user?.email || !isConfigured()) return;

    await request('/subscribers/events', {
        ...subscriberIdentity(user),
        event,
        properties,
        ...(eventId ? { eventId } : {})
    });
}

function fireAndForget(action, label) {
    action().catch(error => {
        console.error(`Sequenzy ${label} failed:`, error.message);
    });
}

function trackSuccessfulApiCall(user, req, statusCode, responseBody) {
    if (!req.path.startsWith('/v1/') || statusCode !== 200) return;

    fireAndForget(() => trackEvent(user, 'signalqub.api_call_succeeded', {
        endpoint: req.path,
        method: req.method,
        provider: responseBody?.provider || null,
        creditsCharged: responseBody?.credits_charged || 0
    }), 'successful API call');
}

function trackCreditDepletion(user, creditsRemaining) {
    fireAndForget(() => trackEvent(user, 'signalqub.credit_depletion', {
        creditsRemaining,
        threshold: 200
    }, `credit-depletion-${user.id}-200`), 'credit depletion');
}

async function scanForIdleUsers(supabase) {
    if (!isConfigured()) return;

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('*')
        .lte('created_at', cutoff)
        .limit(1000);

    if (profilesError) throw profilesError;

    const { data: logs, error: logsError } = await supabase
        .from('api_logs')
        .select('user_id')
        .limit(100000);

    if (logsError) throw logsError;

    const usersWithCalls = new Set((logs || []).map(log => log.user_id));
    for (const profile of profiles || []) {
        if (!profile.email || usersWithCalls.has(profile.id)) continue;

        const user = {
            id: profile.id,
            email: profile.email,
            firstName: profile.first_name || profile.firstName || undefined
        };

        await syncSubscriber(user, {
            signalqubUserId: profile.id,
            signupDate: profile.created_at
        });
        await trackEvent(user, 'signalqub.user_idle_48h', {
            signupDate: profile.created_at,
            creditsRemaining: profile.credits
        }, `idle-48h-${profile.id}`);
    }
}

async function trackAccountCreated(profile) {
    if (!profile?.email || !isConfigured()) return;

    const user = {
        id: profile.id,
        email: profile.email,
        firstName: profile.first_name || profile.firstName || undefined
    };

    await syncSubscriber(user, {
        signalqubUserId: profile.id,
        signupDate: profile.created_at
    });
    await trackEvent(user, 'signalqub.account_created', {
        creditsLoaded: profile.credits,
        dashboardUrl: 'https://signalqub.com/dashboard',
        docsUrl: 'https://signalqub.com/docs'
    }, `account-created-${profile.id}`);
}

function startSignupListener(supabase) {
    if (!isConfigured()) return;

    supabase
        .channel('sequenzy-signups')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'profiles'
        }, payload => {
            trackAccountCreated(payload.new).catch(error => {
                console.error('Sequenzy account-created event failed:', error.message);
            });
        })
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                console.log('Sequenzy signup listener enabled');
            } else {
                console.error(`Sequenzy signup listener status: ${status}`);
            }
        });
}

async function scanRecentSignups(supabase) {
    if (!isConfigured()) return;

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, email, first_name, created_at, credits')
        .gte('created_at', cutoff)
        .limit(1000);

    if (error) throw error;

    for (const profile of profiles || []) {
        await trackAccountCreated(profile);
    }
}

function startIdleUserScanner(supabase) {
    if (!isConfigured()) {
        console.log('Sequenzy integration disabled: SEQUENZY_API_KEY is not set');
        return;
    }

    const run = () => scanForIdleUsers(supabase).catch(error => {
        console.error('Sequenzy idle-user scan failed:', error.message);
    });
    const retryRecentSignups = () => scanRecentSignups(supabase).catch(error => {
        console.error('Sequenzy signup retry failed:', error.message);
    });

    run();
    retryRecentSignups();
    setInterval(run, 60 * 60 * 1000);
    setInterval(retryRecentSignups, 60 * 1000);
}

module.exports = {
    isConfigured,
    syncSubscriber,
    trackAccountCreated,
    trackSuccessfulApiCall,
    trackCreditDepletion,
    startSignupListener,
    startIdleUserScanner
};