// Example fixture: phone stand, ~iPhone 15 width, 60° tilt (mm)
$fn = 48;
phone_w = 76;
tilt = 60;
base_d = 78;
base_t = 4;
back_h = 90;
lip = 10;
cable = 14;

difference() {
  union() {
    cube([phone_w, base_d, base_t]);
    translate([0, 16, base_t])
      rotate([-tilt, 0, 0])
        cube([phone_w, 5, back_h]);
    translate([0, 10, base_t])
      cube([phone_w, lip, 12]);
  }
  translate([phone_w / 2 - cable / 2, -1, -1])
    cube([cable, 16, 20]);
}
