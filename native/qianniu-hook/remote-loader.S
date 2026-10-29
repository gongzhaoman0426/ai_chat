/* Relocatable Win64 LPTHREAD_START_ROUTINE. The only inputs are the addresses
 * in RemoteLoadRequest; no IAT, global data, external calls, or relocations are
 * referenced by the copied bytes. Keep offsets in sync with main.c assertions.
 */
.intel_syntax noprefix
.section .text$qianniu_loader,"xr"
.p2align 4
.globl judesk_remote_loader_begin
.globl judesk_remote_loader_end

judesk_remote_loader_begin:
    /* Entry RSP is 8 mod 16. Save the nonvolatile register holding the request,
     * then reserve Win64's 32-byte shadow space with RSP aligned for each call.
     */
    push rbx
    sub rsp, 32
    mov rbx, rcx
    mov rcx, qword ptr [rbx + 16]
    call qword ptr [rbx]
    mov qword ptr [rbx + 24], rax
    /* Capture LastError immediately, before any other system call. Its value
     * is diagnostic only when LoadLibraryW returned a null module handle.
     */
    call qword ptr [rbx + 8]
    mov dword ptr [rbx + 32], eax
    mov dword ptr [rbx + 36], 1
    xor eax, eax
    add rsp, 32
    pop rbx
    ret
judesk_remote_loader_end:
