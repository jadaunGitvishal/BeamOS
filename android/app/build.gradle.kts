plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.remotedisplay.player"
    // Ref 26 (targetSdk arm): compile against Android 16 (API 36). AGP 8.2.0 was
    // validated up to compileSdk 34; 36 works but needs the unsupported-compileSdk
    // warning suppressed (android.suppressUnsupportedCompileSdk in gradle.properties).
    compileSdk = 36

    defaultConfig {
        applicationId = "com.remotedisplay.player"
        // Ref 26: Android 5.0. 21 is the practical floor — OkHttp 4.x and
        // androidx.security-crypto both require API 21, and the <ripple> button
        // drawable is API 21. Core-library desugaring (below) backports java.time
        // so ScheduleEval works on 21-25 where it isn't in the platform yet.
        minSdk = 21
        // Ref 26 (targetSdk arm): opt in to Android 15/16 (API 35/36) behaviour.
        // Audited behaviour changes that activate at this target: predictive back
        // (MainActivity.onBackPressed is an empty kiosk override — still honoured via
        // the platform compat callback), edge-to-edge enforcement (app is already
        // windowFullscreen immersive), FGS-from-BOOT_COMPLETED restriction on the
        // mediaPlayback type (Relauncher already catches the failure; MainActivity
        // restarts the service from a foreground context), and 16 KB page size
        // (no bundled native libs — non-applicable).
        targetSdk = 36
        versionCode = 41
        versionName = "1.9.2-patch3"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release-key.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD") as String? ?: ""
            keyAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS") as String? ?: "remotedisplay"
            keyPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD") as String? ?: ""
            // #81: AGP ignores enableV1Signing at minSdk>=24, so assembleRelease emits a
            // v2-only APK. The v1 (JAR) signature that some MDM-managed signage (MAXHUB)
            // requires is added by the `resignReleaseV1` task below (apksigner re-sign).
        }
    }

    buildTypes {
        debug {
            
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        // Ref 26 / java.time crash guard: backport java.time (used by ScheduleEval.kt),
        // java.util.stream, etc. down to minSdk. java.time only entered the platform at
        // API 26, so without this ScheduleEval throws NoClassDefFoundError on API 21-25 —
        // a real crash on the CURRENT minSdk 24, not just a future one.
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Ref 26: core-library desugaring runtime — backports java.time & friends to minSdk.
    // 2.1.4 is the current recommended release for AGP 8.x (AGP 8.2 here).
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")

    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ExoPlayer / Media3
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")

    // Socket.IO client
    implementation("io.socket:socket.io-client:2.1.0")

    // WorkManager for background downloads
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Gson for JSON
    implementation("com.google.code.gson:gson:2.10.1")

    // OkHttp for file downloads
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // Ref 32: FusedLocationProvider (Google Play Services) for periodic GPS telemetry.
    // Degrades gracefully where Play Services is absent (many AOSP TV boxes) - the
    // provider just never yields a fix and lat/long stay absent from telemetry.
    implementation("com.google.android.gms:play-services-location:21.3.0")

    // #74/#75: unit tests for the Kotlin schedule evaluator (vector drift guard)
    testImplementation("junit:junit:4.13.2")
}

// #74/#75: point the evaluator drift-guard test at the SHARED vector contract
// (shared/schedule-vectors.json, the single source - no snapshot). rootProject is
// the android/ Gradle root; its parent is the repo root. Any ScheduleEval.kt edit
// that breaks a vector fails ScheduleEvalTest in CI.
tasks.withType<Test> {
    systemProperty("scheduleVectors", File(rootProject.projectDir.parentFile, "shared/schedule-vectors.json").absolutePath)
}

// #81: AGP ignores enableV1Signing at minSdk>=24, so `assembleRelease` produces a
// v2-only APK - and some MDM-managed signage (MAXHUB/Pivot) silently removes a v2-only
// app on the next reboot because its boot integrity check expects a v1 (JAR) signature.
// Re-sign the assembled release APK with apksigner, forcing a low --min-sdk-version so
// the v1 signature is emitted alongside v2/v3. v1+v2+v3 verifies on every Android
// version (legacy MDM hardware via v1, modern Android via v2/v3).
tasks.register<Exec>("resignReleaseV1") {
    val apk = layout.buildDirectory.file("outputs/apk/release/app-release.apk").get().asFile
    onlyIf { apk.exists() }
    doFirst {
        val sdkDir = System.getenv("ANDROID_HOME")
            ?: System.getenv("ANDROID_SDK_ROOT")
            ?: rootProject.file("local.properties").takeIf { it.exists() }
                ?.readLines()?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")?.trim()
            ?: throw GradleException("#81 resign: set ANDROID_HOME or sdk.dir in local.properties")
        val buildTools = File(sdkDir, "build-tools").listFiles()
            ?.filter { it.isDirectory }?.maxByOrNull { it.name }
            ?: throw GradleException("#81 resign: no build-tools found under $sdkDir")
        commandLine(
            File(buildTools, if (System.getProperty("os.name").lowercase().contains("win")) "apksigner.bat" else "apksigner").absolutePath, "sign",
            "--ks", file("../release-key.jks").absolutePath,
            "--ks-key-alias", (System.getenv("KEY_ALIAS") ?: "remotedisplay"),
            "--ks-pass", "pass:" + (System.getenv("KEYSTORE_PASSWORD") ?: ""),
            "--key-pass", "pass:" + (System.getenv("KEY_PASSWORD") ?: ""),
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "true",
            "--v3-signing-enabled", "true",
            "--min-sdk-version", "19",
            apk.absolutePath
        )
    }
}
// AGP registers assembleRelease lazily, so match it when/after it's created.
tasks.matching { it.name == "assembleRelease" }.configureEach { finalizedBy("resignReleaseV1") }
