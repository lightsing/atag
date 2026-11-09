MEMORY
{
  FLASH : ORIGIN = 0x00070000, LENGTH = 48K
  RAM : ORIGIN = 0x20000000, LENGTH = 64K
  UICR_BOOTLOADER : ORIGIN = 0x10001014, LENGTH = 4
}

__bootloader_active_start = 0x19000;
__bootloader_active_end = 0x41000;
__bootloader_dfu_start = 0x41000;
__bootloader_dfu_end = 0x6a000;
__bootloader_state_start = 0x6a000;
__bootloader_state_end = 0x6b000;

SECTIONS
{
  .uicr_bootloader_start_address :
  {
    LONG(ORIGIN(FLASH));
  } > UICR_BOOTLOADER
}
