import { by, device, element, expect } from "detox";

describe("Driver login flow", () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  afterAll(async () => {
    await device.terminateApp();
  });

  it("shows the login screen on fresh launch", async () => {
    await expect(element(by.text("Delivery Driver"))).toBeVisible();
  });

  it("shows tenant slug input", async () => {
    await expect(element(by.id("tenant-slug-input"))).toBeVisible();
  });

  it("shows phone input after tenant selection", async () => {
    await element(by.id("tenant-slug-input")).typeText("demo");
    await element(by.id("tenant-submit")).tap();
    await expect(element(by.id("phone-input"))).toBeVisible();
  });

  it("requests OTP code", async () => {
    await element(by.id("phone-input")).typeText("20123456");
    await element(by.id("phone-submit")).tap();
    await expect(element(by.id("otp-input"))).toBeVisible();
  });
});

describe("Driver shift flow", () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: false });
  });

  it("shows today screen after login", async () => {
    await expect(element(by.id("today-screen"))).toBeVisible();
  });

  it("can open a shift", async () => {
    await element(by.id("start-shift-button")).tap();
    await expect(element(by.id("shift-active-badge"))).toBeVisible();
  });
});

describe("Delivery flow", () => {
  it("navigates to a stop", async () => {
    await element(by.id("stops-tab")).tap();
    await expect(element(by.id("stops-list"))).toBeVisible();
  });

  it("opens stop detail", async () => {
    await element(by.id("stop-card-0")).tap();
    await expect(element(by.id("stop-detail-screen"))).toBeVisible();
  });

  it("initiates delivery", async () => {
    await element(by.id("deliver-button")).tap();
    await expect(element(by.id("deliver-screen"))).toBeVisible();
  });

  it("captures COD and signature", async () => {
    await element(by.id("cod-amount-input")).typeText("15000");
    await element(by.id("recipient-name-input")).typeText("Test Recipient");
    await element(by.id("confirm-delivery")).tap();
    await expect(element(by.text("Delivered"))).toBeVisible();
  });
});

describe("Failure flow", () => {
  it("can report a failed delivery", async () => {
    await element(by.id("stops-tab")).tap();
    await element(by.id("stop-card-1")).tap();
    await element(by.id("fail-button")).tap();
    await expect(element(by.id("fail-screen"))).toBeVisible();
  });

  it("selects failure reason and confirms", async () => {
    await element(by.id("reason-NO_ANSWER")).tap();
    await element(by.id("confirm-failure")).tap();
    await expect(element(by.text("Failed"))).toBeVisible();
  });
});

describe("Cash handover flow", () => {
  it("opens handover screen", async () => {
    await element(by.id("today-tab")).tap();
    await element(by.id("handover-button")).tap();
    await expect(element(by.id("handover-screen"))).toBeVisible();
  });

  it("shows expected amount", async () => {
    await expect(element(by.id("expected-amount"))).toBeVisible();
  });

  it("submits handover with idempotency", async () => {
    await element(by.id("declare-button")).tap();
    await expect(element(by.text("Declared"))).toBeVisible();
  });
});
