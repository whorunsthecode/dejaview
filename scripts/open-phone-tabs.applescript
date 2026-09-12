-- Open every URL from the phone into Google Chrome, in batches so Chrome stays usable.
--
-- iPhone side (Safari): tap the Tabs button, long-press the "N Tabs" label at the
-- bottom, choose "Copy N Links". Universal Clipboard (Handoff on, same iCloud
-- account, Bluetooth/Wi-Fi on) hands the clipboard to this Mac within a few seconds.
-- Safari copies rich text, so URLs are pulled from the RTF hyperlink fields, falling
-- back to plain text.
--
-- Mac side:  osascript scripts/open-phone-tabs.applescript            (reads clipboard)
--            osascript scripts/open-phone-tabs.applescript urls.txt   (reads a file, one URL per line)

on run argv
	set batchSize to 50
	set pauseSeconds to 20

	if (count of argv) > 0 then
		set raw to do shell script "cat " & quoted form of (item 1 of argv)
	else
		try
			set raw to do shell script "pbpaste -Prefer rtf | grep -Eo 'HYPERLINK \"[^\"]+\"' | sed -E 's/HYPERLINK \"(.*)\"/\\1/' | sed 's/\\\\\\\\/\\\\/g'"
		on error
			set raw to ""
		end try
		if raw is "" then set raw to do shell script "pbpaste -Prefer txt | grep -Eo 'https?://[^[:space:]\"]+' || true"
	end if

	set urls to {}
	repeat with l in paragraphs of raw
		set s to contents of l
		if (s starts with "http://" or s starts with "https://") and urls does not contain s then set end of urls to s
	end repeat

	set total to count of urls
	if total is 0 then
		display alert "No URLs found." message "On the iPhone: Tabs → long-press \"N Tabs\" → Copy N Links."
		return
	end if

	tell application "Google Chrome"
		activate
		set w to make new window
		set URL of active tab of w to item 1 of urls
		repeat with i from 2 to total
			tell w to make new tab with properties {URL:item i of urls}
			if i mod batchSize is 0 and i < total then
				display notification ("Opened " & i & " of " & total & ", pausing " & pauseSeconds & "s…") with title "Phone tabs"
				delay pauseSeconds
			end if
		end repeat
	end tell
	display notification (total as text) & " tabs opened in Chrome" with title "Phone tabs"
end run
