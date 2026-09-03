const sparticuzRaw = require('@sparticuz/chromium');
// 1. Handle ES module imports automatically
const sparticuz = sparticuzRaw.default || sparticuzRaw; 

function applyPatch(moduleName) {
    try {
        const pkg = require(moduleName);
        if (!pkg || !pkg.chromium) return;

        const originalLaunch = pkg.chromium.launch.bind(pkg.chromium);

        pkg.chromium.launch = async function(options = {}) {
            // 2. Safely handle both getter and function versions of Sparticuz
            const execPath = typeof sparticuz.executablePath === 'function' 
                ? await sparticuz.executablePath() 
                : await sparticuz.executablePath;
                
            console.log(`[Playwright Patch] Launching custom binary: ${execPath}`);

            options.executablePath = execPath;
            
            const sparticuzArgs = sparticuz.args || [];
            options.args = [
                ...sparticuzArgs,
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