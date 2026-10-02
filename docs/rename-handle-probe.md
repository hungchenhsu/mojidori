# Retained-handle rename probe (#280)

This headless integration probe tests an alternative to pairing unrelated
`notify` events by arrival order. It does not change application behavior,
and #280 remains open.

**Conclusion: do not adopt a continuously retained handle as the cross-platform
fix.** On the Windows CI filesystem, even a metadata-only handle prevents an
external parent-directory rename with `ERROR_ACCESS_DENIED`; closing that handle
is required before the rename can succeed. This is a user-visible regression a
rename-tracking feature must not introduce.

Run with `cd src-tauri && cargo test --test rename_handle_probe`. The normal
macOS/Windows CI test command also executes it. Linux is intentionally outside
this probe; a production implementation still needs a Linux policy.

## Candidate mechanism

- Keep the opened file handle alive while resolving its current path.
- macOS: `fcntl(F_GETPATH)` returns the handle's path; compare the retained
  and newly opened candidate handles using `(st_dev, st_ino)`.
- Windows: `GetFinalPathNameByHandleW` returns a UTF-16 path (including the
  extended path prefix). Compare volume serial number plus the full 128-bit
  `FILE_ID_INFO.FileId`, rather than truncating the ID to 64 bits.
  The candidate uses zero desired access and explicit read/write/delete
  sharing; a separate control retains a normal read handle.
- Reject an OS error, missing candidate, or identity mismatch. Do not silently
  use the old document path as proof of identity.

The probe uses only the standard library and native OS calls. No runtime
dependency or production module is added.

## Cases and evidence

Local macOS execution on 2026-10-03 passed all six tests. Two Windows CI
experiments established the same parent-rename denial with
[a normal read handle](https://github.com/hungchenhsu/mojidori/actions/runs/37042307941)
and [a metadata-only handle](https://github.com/hungchenhsu/mojidori/actions/runs/37043103957).
Both failed at the parent-directory rename, after the cross-directory file
rename and identity check had succeeded; the other cases passed. The final
probe pins that measured platform difference, and checks that closing each
Windows handle permits the parent rename. Each platform runs six tests (macOS
adds a symlink case; Windows adds the normal-read-handle control).

| Case | Required observation |
| --- | --- |
| Same-directory rename; unrelated file reuses old path | Resolve the renamed original, reject the unrelated file's identity |
| Cross-directory move | Resolve the new file path on both platforms |
| Subsequent parent-directory rename | macOS resolves the new path; Windows denies rename while the handle is open, then permits it after close |
| Delete; then reuse old path | No verified candidate at either step |
| Atomic replacement at the same path | Old handle has no verified candidate; a newly opened handle resolves the saved file |
| Hard link | Multiple paths have the same identity; identity cannot select the intended document path |
| macOS symlink | Open handle resolves the target, not the symlink spelling used to open it |

These observations cover local test filesystems only. They do not establish
network-share support, cross-volume move tracking, Windows symlink behavior,
permission-change behavior, or every filesystem's ID/API support.

## Remaining production design

The retained-handle experiment is rejected as a general cross-platform fix.
Its successful cases prove only a limited path-discovery primitive. A correct
fix still needs:

1. A watch strategy that notices a rename and rearms after relocation,
   including changes to a containing directory. The old file watch alone
   stops reporting writes to the new location (the earlier #280 probe).
2. Document ID and watch-generation checks so delayed events cannot retarget
   a closed/reopened tab or overwrite a newer Save As result.
3. Serialization with save/reload, including refreshing the retained handle
   after Mojidori's atomic save replaces the underlying file.
4. An explicit hard-link/symlink policy. Equal file IDs prove object identity,
   not the user's preferred path. Do not silently canonicalize aliases.
5. Stale-file protection even after a candidate passes this probe. Another
   process can change the namespace immediately afterward; a verified path
   is not a race-free authorization to write or bypass the overwrite prompt.
6. Conservative fallback when path or identity APIs are unavailable, and
   tests of the complete rename → watch → reload/save state transitions.

Future investigations should prefer short-lived identity queries on actual
rename-event candidates, with conservative ambiguity rejection, over holding
handles indefinitely or pairing events purely by arrival order. Cross-directory
and ancestor moves remain explicit design problems, not solved by this probe.

## API references

- [Apple fcntl manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
- [GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
- [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex)
- [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)
- [CreateFileW access and sharing](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
