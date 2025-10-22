import assert from "node:assert/strict";

import { escapeXmlAttr } from "./report.js";

function runEscapeTest() {
    const input = `Build "alpha" & beta's <gamma>`;
    const escaped = escapeXmlAttr(input);
    assert.equal(
        escaped,
        "Build &quot;alpha&quot; &amp; beta&apos;s &lt;gamma&gt;",
        "escapeXmlAttr should convert XML attribute special characters to entities",
    );
}

runEscapeTest();
