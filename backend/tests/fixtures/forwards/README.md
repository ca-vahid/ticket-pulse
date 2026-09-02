# Forwarded-mail fixtures (Phase FW-1)

Hand-written, anonymised bodies as the major clients emit them when a user hits
**Forward**. Structure (marker lines, header-block layout, container ids) follows
what each client really sends; addresses/names/content are fictional.

Marker/label structure adapted from the MIT-licensed fixtures of
[email-forward-parser](https://github.com/crisp-oss/email-forward-parser)
(Copyright (c) Crisp IM SAS) — credit as required by the MIT licence. No fixture
is copied verbatim.

| file | client | notes |
|---|---|---|
| outlook-owa.html | Outlook on the web / new Outlook (Win) | `#appendonsend` + `<hr display:inline-block;width:98%>` + `#divRplyFwdMsg` |
| outlook-desktop-classic.html | classic Outlook desktop (Word HTML) | `border-top:solid #E1E1E1 1.0pt` block, `[mailto:]` address form |
| outlook-desktop-de.html | classic Outlook desktop, German UI | `Von/Gesendet/An/Betreff`, `WG:` subject |
| outlook-mac-new.html | new Outlook for Mac | `#appendonsend` + `#divRplyFwdMsg`, blank line after From |
| outlook-ios.html | Outlook for iOS | `#ms-outlook-mobile-signature` + `#mail-editor-reference-message-container` |
| gmail.html / gmail.txt | Gmail (HTML + plain text) | `---------- Forwarded message ---------`, `.gmail_quote/.gmail_attr` |
| apple-mail.html | Apple Mail (macOS) | `Begin forwarded message:` + `<blockquote type="cite">`, one div per header |
| nested-outlook-chain.html | OWA forward of a classic-Outlook forward | only the TOP block is parsed in v1 |
| signature-with-From-line.html | negative | a signature that says `From:` with no Sent/Date line |
| reply-not-forward.html | negative | an Outlook REPLY quoting our own mail (`RE:` subject) — header block present, not a forward |
