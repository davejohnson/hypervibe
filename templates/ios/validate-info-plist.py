# Embedded after reading the main app's Info.plist in both isolated validators.
# Expected values come from the reviewed workflow's step environment, never IPA outputs.
import json

expected_info = json.loads(os.environ["HYPERVIBE_EXPECTED_INFO_PLIST"])
if not isinstance(info, dict) or not isinstance(expected_info, dict):
    raise SystemExit("IPA Info.plist configuration must be a dictionary")
for key, expected_value in expected_info.items():
    actual_value = info.get(key)
    if not isinstance(expected_value, str) or not isinstance(actual_value, str) or actual_value != expected_value:
        # Embedded data can contain secrets. Report the declared key without either value.
        raise SystemExit("IPA Info.plist does not match expectedInfoPlist for " + key)
