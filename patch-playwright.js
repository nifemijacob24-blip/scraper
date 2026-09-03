const rawModule = require('@sparticuz/chromium');
const sparticuz = rawModule.default || rawModule;

function applyPatch(moduleName) {
    try {
        const pkg = require(moduleName);
        if (!pkg || !pkg.chromium) return;

        const originalLaunch = pkg.chromium.launch.bind(pkg.chromium);

        pkg.chromium.launch = async function(options = {}) {
            console.log(`[Playwright Patch] Sparticuz Module exports:`, Object.keys(sparticuz));

            // Safely extract the path regardless of NPM package version
            let execPath;
            if (typeof sparticuz.executablePath === 'function') {
                execPath = await sparticuz.executablePath();
            } else if (sparticuz.executablePath) {
                execPath = await sparticuz.executablePath;
            } else {
                throw new Error("Sparticuz did not export executablePath. Verify the GitHub Action installed the package.");
            }

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

applyPatch('playwright');
applyPatch('playwright-core');