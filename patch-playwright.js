const sparticuz = require('@sparticuz/chromium');

function applyPatch(moduleName) {
    try {
        const pkg = require(moduleName);
        if (!pkg || !pkg.chromium) return;

        const originalLaunch = pkg.chromium.launch.bind(pkg.chromium);

        pkg.chromium.launch = async function(options = {}) {
            const execPath = await sparticuz.executablePath();
            console.log(`[Playwright Patch] Launching custom binary: ${execPath}`);

            options.executablePath = execPath;
            options.args = [
                ...(sparticuz.args || []),
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                ...(options.args || [])
            ];

            return await originalLaunch(options);
        };
        console.log(`[Playwright Patch] Successfully patched ${moduleName}`);
    } catch (e) {
        // Module not installed, safe to ignore
    }
}

// Patch both possible packages
applyPatch('playwright');
applyPatch('playwright-core');