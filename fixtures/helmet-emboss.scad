// Fixture: helmet with embossed crest on the back (mm)
// Region: back (−Y). Unspecified region would default to largest vertical / front (+Y).
// Emboss height 0.8 mm (raised). Shell wall 2.4 mm so #11 1.6 mm remains if etched later.
// Honest stub: primitive crest, not Style2Fab / neural stylization.
$fn = 48;
body_w = 96;
body_d = 108;
body_h = 64;
wall = 2.4;
emboss_h = 0.8;

module helmet_shell() {
  difference() {
    union() {
      cube([body_w, body_d, body_h * 0.62]);
      translate([body_w / 2, body_d / 2, body_h * 0.5])
        scale([1, body_d / body_w, (body_h * 0.9) / body_w])
          sphere(r = body_w / 2);
    }
    translate([wall, wall, -1])
      cube([body_w - 2 * wall, body_d - 2 * wall, body_h * 0.62 + 1]);
    translate([body_w / 2, body_d / 2, body_h * 0.5])
      scale([1, (body_d - 2 * wall) / (body_w - 2 * wall), (body_h * 0.9 - wall) / (body_w - 2 * wall)])
        sphere(r = (body_w - 2 * wall) / 2);
    translate([16, body_d - 18, 14])
      cube([body_w - 32, 22, 36]);
    translate([-4, -4, -40]) cube([body_w + 8, body_d + 8, 40]);
  }
}

module crest_motif() {
  translate([body_w / 2 - 6, -emboss_h, 22]) cube([12, emboss_h + 0.3, 14]);
  translate([body_w / 2 - 1, -emboss_h, 16]) cube([2, emboss_h + 0.3, 7]);
  translate([body_w / 2 - 5, -emboss_h, 31]) cube([10, emboss_h + 0.3, 2]);
  translate([body_w / 2 - 1, -emboss_h, 24]) cube([2, emboss_h + 0.3, 8]);
}

union() {
  helmet_shell();
  crest_motif();
}
