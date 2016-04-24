plist_path=$1/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk/Developer/Library/LaunchDaemons/com.apple.instruments.deviceservice.plist
iwd_path=$2/thirdparty/iwd7
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" $plist_path || echo "Dictionary entry exists, resetting entries within it"
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:DYLD_INSERT_LIBRARIES string $iwd_path/DTMobileISShim.dylib" $plist_path
/usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:LIB_PATH string $iwd_path/" $plist_path
