MEMORY
{
  /* Nordic S112 7.3.0 occupies 0x00000000..0x00019000. */
  /* 160 KiB active image. OTA staging/state/bootloader follow below 0x7c000.
     Final 16 KiB store the profile and rotation checkpoints. */
  FLASH : ORIGIN = 0x00019000, LENGTH = 0x00028000

  /* Reserve 16 KiB for S112 and leave 48 KiB to the application. */
  RAM : ORIGIN = 0x20004000, LENGTH = 0x0000C000
}
