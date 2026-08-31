import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * The view the app opens on when no share link supplies one.
 *
 * Framing is field-tested, not derived — an earlier 7000 m / -35 degree /
 * heading 320 attempt put the look-at point roughly 10 km out to the
 * north-north-west, landing near Whipple Ave on the Union City/Hayward border
 * with Fremont behind the camera. The look-at arithmetic was right; the aim
 * was not.
 *
 * These values put the target about 4.2 km out (6000 / tan 55), which centres
 * Fremont itself, and heading 0 looks due north up the bay rather than
 * south-east into Mission Peak. The steeper pitch is what pulls the target
 * back onto the city.
 */
export const STARTUP_VIEW = Object.freeze({
  label: 'Fremont, CA',
  lon: -121.9886,
  lat: 37.5485,
  altitude: 6000,
  heading: 0,
  pitch: -55,
  /** Overhead drop-in point for the cinematic approach. */
  approachAltitude: 45000,
});

/**
 * Set the opening camera with a cinematic fly-in: drop in from directly
 * overhead, then settle into the framed oblique view.
 */
export function flyToStartupView(viewer, view = STARTUP_VIEW) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.approachAltitude),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  setTimeout(() => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.altitude),
      orientation: {
        heading: Cesium.Math.toRadians(view.heading),
        pitch: Cesium.Math.toRadians(view.pitch),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
}
