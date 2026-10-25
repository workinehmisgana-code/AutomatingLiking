plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.repostearn.bubble"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.repostearn.bubble"
        minSdk = 26
        targetSdk = 33
        versionCode = 12
        versionName = "4.1"
    }

    buildFeatures {
        buildConfig = true
    }

    // TWO APPS FROM ONE SOURCE. "helper" is the Comment Helper workers use.
    // "tester" is a separate install (its own package, name and sign-in link)
    // for testing accounts: it is only served links that carry none of our
    // product comments, and its bubble has a Check button that asks whether the
    // comment just posted from this TikTok account is visible on the video.
    //   assembleHelperDebug -> app-helper-debug.apk
    //   assembleProbeDebug  -> app-probe-debug.apk  (Android forbids a flavour called "test…")
    flavorDimensions += "app"
    productFlavors {
        create("helper") {
            dimension = "app"
            resValue("string", "app_name", "Comment Helper")
            buildConfigField("boolean", "TESTER", "false")
            manifestPlaceholders["authScheme"] = "nextbubble"
        }
        create("probe") {
            dimension = "app"
            applicationIdSuffix = ".tester"
            resValue("string", "app_name", "Comment Tester")
            buildConfigField("boolean", "TESTER", "true")
            manifestPlaceholders["authScheme"] = "nextbubbletest"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.22")
    // The heart rules exist in Kotlin here and in Python in
    // 2_comment_automation. LikerRulesTest runs the cases check_to_top.py
    // asserts on the other side, which is the only thing standing between the
    // two implementations and a quiet disagreement about how many hearts land
    // on somebody's video.
    testImplementation("junit:junit:4.13.2")
}
